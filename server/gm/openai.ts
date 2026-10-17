/**
 * Ведущий на OpenAI-совместимом API (Groq, Gemini, Cerebras, OpenRouter, локальная Ollama и т.п.).
 * Без SDK: fetch + потоковые ответы (SSE). Инструменты — function calling.
 */
import type { Room } from '../rooms'
import { buildCompactPrompt } from './prompt'
import { GM_TOOLS_OPENAI, executeGmTool } from './tools'
import { ProviderError, type LlmProvider } from './types'

export interface OpenAiCompatConfig {
  id: string
  label: string
  baseUrl: string
  apiKey?: string
  model: string
  maxTokens?: number
  temperature?: number
  /** сколько последних сообщений истории отправлять (лимиты токенов бесплатных тарифов малы) */
  historyLimit?: number
  timeoutMs?: number
  maxSteps?: number
}

type OaToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type OaMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const HOUR = 3600_000

export function cooldownFor(status: number, retryAfter: string | null): number {
  if (status === 429) {
    const s = Number(retryAfter)
    return Number.isFinite(s) && s > 0 ? s * 1000 : 60_000
  }
  if (status === 401 || status === 403 || status === 404) return HOUR
  return 30_000
}

/** Последние сообщения так, чтобы окно начиналось с реплики пользователя (без осиротевших ответов инструментов) */
export function windowHistory(hist: OaMsg[], limit: number): OaMsg[] {
  if (hist.length <= limit) return hist
  let start = hist.length - limit
  while (start < hist.length && hist[start].role !== 'user') start++
  return hist.slice(start)
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string
  readonly label: string
  private system = buildCompactPrompt()

  constructor(private cfg: OpenAiCompatConfig, private fetchImpl: typeof fetch = fetch) {
    this.id = cfg.id
    this.label = cfg.label
  }

  async turn(room: Room, input: { userText: string; snapshot: string }, io: { delta(text: string): void; stateChanged(): void }): Promise<string> {
    const hist = (room.gmHistories[this.id] ??= []) as OaMsg[]
    const mark = hist.length
    // состояние партии — в той же реплике: не все совместимые API принимают system посреди разговора
    hist.push({ role: 'user', content: `${input.userText}\n\n[Состояние партии — сообщение сервера, а не игроков]\n${input.snapshot}` })
    let text = ''
    try {
      for (let step = 0; step < (this.cfg.maxSteps ?? 8); step++) {
        const { content, toolCalls } = await this.request(hist, (d) => { text += d; io.delta(d) })
        if (!toolCalls.length) {
          hist.push({ role: 'assistant', content })
          break
        }
        hist.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
        for (const tc of toolCalls) {
          let args: unknown
          try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { args = undefined }
          const out = args === undefined ? { content: 'INVALID_JSON: аргументы не разобраны, повтори вызов', isError: true } : executeGmTool(room, tc.function.name, args)
          hist.push({ role: 'tool', tool_call_id: tc.id, content: out.isError ? `Ошибка: ${out.content}` : out.content })
        }
        io.stateChanged()
        if (text && !text.endsWith('\n')) { text += '\n\n'; io.delta('\n\n') }
      }
    } catch (e) {
      hist.length = mark
      if (e instanceof ProviderError) throw e
      throw new ProviderError(`${this.label}: ${(e as Error).message}`, 30_000)
    }
    if (!text.trim()) {
      hist.length = mark
      throw new ProviderError(`${this.label}: пустой ответ`, 30_000)
    }
    // хранимая история тоже ограничена (в запрос и так уходит только окно последних сообщений)
    const keep = Math.max(200, (this.cfg.historyLimit ?? 40) * 4)
    if (hist.length > keep) {
      const kept = windowHistory(hist, keep)
      hist.splice(0, hist.length - kept.length)
    }
    return text.trim()
  }

  private async request(hist: OaMsg[], onText: (d: string) => void): Promise<{ content: string; toolCalls: OaToolCall[] }> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [{ role: 'system', content: this.system }, ...windowHistory(hist, this.cfg.historyLimit ?? 40)],
        tools: GM_TOOLS_OPENAI,
        tool_choice: 'auto',
        stream: true,
        max_tokens: this.cfg.maxTokens ?? 1500,
        temperature: this.cfg.temperature ?? 0.8,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 90_000),
    })
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(`${this.label}: HTTP ${res.status} ${body.slice(0, 160)}`, cooldownFor(res.status, res.headers.get('retry-after')))
    }
    let content = ''
    const calls: { id?: string; name: string; args: string }[] = []
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; error?: { message?: string } }
        try { chunk = JSON.parse(data) } catch { continue }
        if (chunk.error) throw new ProviderError(`${this.label}: ${chunk.error.message ?? 'ошибка'}`, 30_000)
        const d = chunk.choices?.[0]?.delta
        if (!d) continue
        if (d.content) { content += d.content; onText(d.content) }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? calls.length
          calls[i] ??= { name: '', args: '' }
          if (tc.id) calls[i].id = tc.id
          if (tc.function?.name) calls[i].name += tc.function.name
          if (tc.function?.arguments) calls[i].args += tc.function.arguments
        }
      }
    }
    const toolCalls: OaToolCall[] = calls.filter(Boolean).filter((c) => c.name).map((c, i) => ({ id: c.id ?? `call_${Date.now().toString(36)}_${i}`, type: 'function', function: { name: c.name, arguments: c.args } }))
    return { content, toolCalls }
  }
}
