/**
 * Ведущий на OpenAI-совместимом API (Groq, Gemini, Cerebras, OpenRouter, локальная Ollama и т.п.).
 * Без SDK: fetch + потоковые ответы (SSE). Инструменты — function calling.
 */
import type { Room } from '../rooms'
import { buildCompactPrompt } from './prompt'
import { GM_TOOLS_OPENAI, executeGmTool } from './tools'
import { ProviderError, describeTool, type LlmProvider } from './types'

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
  /** дополнительные поля запроса (например, reasoning_effort у gpt-oss на Groq) */
  extraBody?: Record<string, unknown>
  /** просить у API расход токенов в потоке и писать его в консоль сервера */
  usage?: boolean
  /** лимит на короткое время (429 с retry-after не дольше этого) — подождать и повторить, а не отдавать ход дальше */
  maxRetryWaitMs?: number
  /** пауза перед повтором при временной ошибке провайдера (500/502/503) */
  transientRetryMs?: number
}

/** extra_content — служебные данные провайдера у вызова инструмента (подпись мысли Gemini 3); их надо вернуть в истории */
type OaToolCall = { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: Record<string, unknown> }
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
  // длинный ход (много вызовов инструментов) не должен вытеснить свою же реплику игрока: окно не позже последней
  let lastUser = hist.length - 1
  while (lastUser > 0 && hist[lastUser].role !== 'user') lastUser--
  return hist.slice(Math.min(start, lastUser))
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
    room.gmMarks[this.id] = mark
    // состояние партии — в той же реплике: не все совместимые API принимают system посреди разговора
    hist.push({ role: 'user', content: `${input.userText}\n\n[Состояние партии — сообщение сервера, а не игроков]\n${input.snapshot}` })
    let text = ''
    const done: string[] = []
    try {
      for (let step = 0; step < (this.cfg.maxSteps ?? 8); step++) {
        const { content, toolCalls } = await this.request(hist, (d) => { text += d; io.delta(d) })
        if (!toolCalls.length) {
          hist.push({ role: 'assistant', content })
          break
        }
        hist.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
        let ends = false
        for (const tc of toolCalls) {
          let args: unknown
          try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { args = undefined }
          const out = args === undefined ? { content: 'INVALID_JSON: аргументы не разобраны, повтори вызов', isError: true } : executeGmTool(room, tc.function.name, args)
          if (!out.isError) { const d = describeTool(tc.function.name, args); done.push(d); room.gmDone.push(d) }
          if (out.endsTurn && !out.isError) ends = true
          hist.push({ role: 'tool', tool_call_id: tc.id, content: out.isError ? `Ошибка: ${out.content}` : out.content })
        }
        io.stateChanged()
        // бой начат, а рассказ уже есть — ход закончен без лишнего запроса (бесплатные квоты малы)
        if (ends && text.trim()) {
          hist.push({ role: 'assistant', content: 'Бой начался — игроки сражаются на экране боя.' })
          break
        }
        if (text && !text.endsWith('\n')) { text += '\n\n'; io.delta('\n\n') }
      }
    } catch (e) {
      hist.length = mark
      delete room.gmMarks[this.id]
      const pe = e instanceof ProviderError ? e : new ProviderError(`${this.label}: ${(e as Error).message}`, 30_000)
      pe.done = done
      throw pe
    }
    if (!text.trim()) {
      if (done.length) {
        // модель выполнила действия, но не дописала рассказ (рассуждения съели лимит): ход засчитан, иначе следующая
        // модель повторит те же награды и урон
        text = 'Ведущий сделал ход — подробности в журнале игры.'
        const last = hist[hist.length - 1]
        if (last?.role === 'assistant' && !last.tool_calls?.length) last.content = text
        else hist.push({ role: 'assistant', content: text })
      } else {
        hist.length = mark
        delete room.gmMarks[this.id]
        throw new ProviderError(`${this.label}: пустой ответ`, 30_000)
      }
    }
    delete room.gmMarks[this.id]
    // хранимая история тоже ограничена (в запрос и так уходит только окно последних сообщений)
    const keep = Math.max(200, (this.cfg.historyLimit ?? 40) * 4)
    if (hist.length > keep) {
      const kept = windowHistory(hist, keep)
      hist.splice(0, hist.length - kept.length)
    }
    return text.trim()
  }

  private async request(hist: OaMsg[], onText: (d: string) => void, retried = false): Promise<{ content: string; toolCalls: OaToolCall[] }> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [{ role: 'system', content: this.system }, ...windowHistory(hist, this.cfg.historyLimit ?? 40)],
        tools: GM_TOOLS_OPENAI,
        tool_choice: 'auto',
        stream: true,
        ...(this.cfg.usage ? { stream_options: { include_usage: true } } : {}),
        max_tokens: this.cfg.maxTokens ?? 1500,
        temperature: this.cfg.temperature ?? 0.8,
        ...this.cfg.extraBody,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 90_000),
    })
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      // сколько ждать: заголовок retry-after (Groq) или retryDelay в теле ответа (Gemini)
      const retryAfter = res.headers.get('retry-after') ?? body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1] ?? null
      const wait = cooldownFor(res.status, retryAfter)
      const daily = res.status === 429 && /PerDay/i.test(body)
      if (daily) throw new ProviderError(`${this.label}: дневная квота исчерпана`, Math.max(wait, 3600_000))
      if (res.status === 429 && retryAfter && !retried && wait <= (this.cfg.maxRetryWaitMs ?? 20_000)) {
        // лимит на секунды (токены в минуту) — подождать один раз, а не отдавать ход другой модели
        console.log(`[ведущий ${this.label}] лимит, жду ${Math.ceil(wait / 1000)} с`)
        await new Promise((r) => setTimeout(r, wait))
        return this.request(hist, onText, true)
      }
      if ((res.status === 503 || res.status === 502 || res.status === 500) && !retried) {
        // «модель перегружена» обычно проходит за секунды — один повтор, потом уже следующая модель
        console.log(`[ведущий ${this.label}] HTTP ${res.status}, повтор через ${(this.cfg.transientRetryMs ?? 2000) / 1000} с`)
        await new Promise((r) => setTimeout(r, this.cfg.transientRetryMs ?? 2000))
        return this.request(hist, onText, true)
      }
      throw new ProviderError(`${this.label}: HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 400)}`, wait)
    }
    let content = ''
    const calls: { id?: string; name: string; args: string; extra?: Record<string, unknown> }[] = []
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
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
        let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }[] } }[]; error?: { message?: string }; usage?: typeof usage }
        try { chunk = JSON.parse(data) } catch { continue }
        if (chunk.error) throw new ProviderError(`${this.label}: ${chunk.error.message ?? 'ошибка'}`, 30_000)
        if (chunk.usage) usage = chunk.usage
        const d = chunk.choices?.[0]?.delta
        if (!d) continue
        if (d.content) { content += d.content; onText(d.content) }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? calls.length
          calls[i] ??= { name: '', args: '' }
          if (tc.id) calls[i].id = tc.id
          if (tc.function?.name) calls[i].name += tc.function.name
          if (tc.function?.arguments) calls[i].args += tc.function.arguments
          if (tc.extra_content) calls[i].extra = { ...calls[i].extra, ...tc.extra_content }
        }
      }
    }
    const toolCalls: OaToolCall[] = calls.filter(Boolean).filter((c) => c.name).map((c, i) => ({
      id: c.id ?? `call_${Date.now().toString(36)}_${i}`, type: 'function', function: { name: c.name, arguments: c.args },
      ...(c.extra ? { extra_content: c.extra } : {}),
    }))
    if (usage) console.log(`[ведущий ${this.label}] запрос: вход ${usage.prompt_tokens ?? '?'}, выход ${usage.completion_tokens ?? '?'} токенов`)
    return { content, toolCalls }
  }
}
