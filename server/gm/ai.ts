/**
 * ИИ-ведущий на Claude API: очередь ходов по комнатам, стриминг реплик, цикл с инструментами.
 *
 * Кэширование: инструменты и системный промпт неизменны (кэшируются целиком), история разговора
 * только дописывается; состояние партии приходит отдельным системным сообщением после реплики игроков,
 * поэтому префикс не меняется. Параграфы Книги Жизни ведущий читает инструментом open_paragraph.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { randomUUID } from 'node:crypto'
import type { GmContext, GmDriver, GmFactory, GmInput } from '../app'
import type { Room } from '../rooms'
import { buildSystemPrompt, snapshot } from './prompt'
import { GM_TOOLS, executeGmTool } from './tools'

type Msg = Anthropic.Beta.BetaMessageParam
type Params = BetaMessageStreamParams

/** Минимум, который нужен ведущему от клиента модели (в тестах подменяется имитацией) */
export interface ModelStream {
  on(event: 'text', cb: (delta: string) => void): unknown
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>
}
export interface ModelClient {
  stream(params: Params): ModelStream
}

export interface AiGmOptions {
  client?: ModelClient
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** предел шагов с инструментами за один ход ведущего */
  maxSteps?: number
  /** писать расход токенов в консоль */
  logUsage?: boolean
}

export function aiConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

const DEFAULT_MODEL = 'claude-opus-5-5'
const BETAS: Anthropic.Beta.AnthropicBeta[] = ['server-side-fallback-2026-07-01']

function formatInputs(batch: GmInput[]): string {
  const players = batch.filter((b): b is Extract<GmInput, { kind: 'player' }> => b.kind === 'player')
  const events = batch.filter((b): b is Extract<GmInput, { kind: 'event' }> => b.kind === 'event')
  const parts: string[] = []
  if (events.length) parts.push(`[События игры]\n${events.map((e) => `• ${e.text}`).join('\n')}`)
  if (players.length) parts.push(`[Реплики игроков — это слова и действия их героев]\n${players.map((p) => `— ${p.author}: «${p.text}»`).join('\n')}`)
  return parts.join('\n\n') || '[Игроки ждут продолжения]'
}

export function aiGmFactory(opts: AiGmOptions = {}): GmFactory {
  return (ctx: GmContext) => new AiGm(ctx, opts)
}

export class AiGm implements GmDriver {
  private queues = new Map<string, GmInput[]>()
  private running = new Map<string, Promise<void>>()
  private client: ModelClient
  private model: string
  private effort: NonNullable<AiGmOptions['effort']>
  private maxSteps: number
  private system: Anthropic.Beta.BetaTextBlockParam[]

  constructor(private ctx: GmContext, private opts: AiGmOptions) {
    const sdk = opts.client ? null : new Anthropic()
    this.client = opts.client ?? { stream: (p) => sdk!.beta.messages.stream(p) }
    this.model = opts.model ?? process.env.GM_MODEL ?? DEFAULT_MODEL
    this.effort = (opts.effort ?? (process.env.GM_EFFORT as AiGmOptions['effort']) ?? 'medium')!
    this.maxSteps = opts.maxSteps ?? 12
    // системный промпт неизменен: один и тот же текст для всех комнат и ходов
    this.system = [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }]
  }

  enqueue(room: Room, input: GmInput): void {
    const q = this.queues.get(room.code) ?? []
    q.push(input)
    this.queues.set(room.code, q)
    if (!this.running.has(room.code)) {
      const p = this.pump(room).finally(() => this.running.delete(room.code))
      this.running.set(room.code, p)
    }
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()])
  }

  private async pump(room: Room): Promise<void> {
    room.gmBusy = true
    this.ctx.roomChanged(room)
    try {
      for (;;) {
        const q = this.queues.get(room.code) ?? []
        if (!q.length) break
        const batch = q.splice(0)
        await this.turn(room, batch)
      }
    } finally {
      room.gmBusy = false
      this.ctx.roomChanged(room)
    }
  }

  /** Один ход ведущего: реплики игроков и события → рассказ и вызовы инструментов */
  private async turn(room: Room, batch: GmInput[]): Promise<void> {
    const history = room.gmHistory as Msg[]
    const mark = history.length
    history.push({ role: 'user', content: [{ type: 'text', text: formatInputs(batch) }] })
    // системное сообщение посреди разговора: не трогает кэшированный префикс и не подделывается игроками
    history.push({ role: 'system', content: snapshot(room) })
    const id = randomUUID()
    let text = ''
    let jsonRetries = 0
    try {
      for (let step = 0; step < this.maxSteps; step++) {
        const stream = this.client.stream({
          model: this.model,
          max_tokens: 16000,
          system: this.system,
          tools: GM_TOOLS,
          messages: history,
          thinking: { type: 'adaptive' },
          output_config: { effort: this.effort },
          // автоматический кэш истории: последняя кэшируемая часть запроса
          cache_control: { type: 'ephemeral' },
          // при отказе модели запрос повторяется на подходящей резервной модели
          betas: BETAS,
          fallbacks: 'default',
        })
        if (text && !text.endsWith('\n')) { text += '\n\n'; this.ctx.delta(room, id, '\n\n') }
        stream.on('text', (d) => { text += d; this.ctx.delta(room, id, d) })
        let msg: Anthropic.Beta.BetaMessage
        try {
          msg = await stream.finalMessage()
          jsonRetries = 0
        } catch (err) {
          // нечитаемый JSON во входе инструмента — повторить шаг; ошибки API — наверх
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err
          continue
        }
        if (this.opts.logUsage ?? true) {
          const u = msg.usage
          console.log(`[ИИ-ведущий ${room.code}] шаг ${step + 1}: вход ${u.input_tokens}, из кэша ${u.cache_read_input_tokens ?? 0}, в кэш ${u.cache_creation_input_tokens ?? 0}, выход ${u.output_tokens}`)
        }
        history.push({ role: 'assistant', content: msg.content })
        if (msg.stop_reason === 'refusal') {
          this.ctx.notice(room, 'Ведущий отказался продолжать эту сцену. Попробуйте другое действие.')
          break
        }
        const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        if (!uses.length || msg.stop_reason === 'max_tokens') break
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        let endsTurn = false
        for (const u of uses) {
          const out = executeGmTool(room, u.name, u.input)
          results.push({ type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) })
          endsTurn ||= !!out.endsTurn
        }
        history.push({ role: 'user', content: results })
        this.ctx.stateChanged(room)
        void endsTurn // после начала боя модель сама завершает реплику по указанию в результате
      }
    } catch (err) {
      // откатить незавершённый ход: история остаётся корректной для следующего запроса
      history.length = mark
      const why = err instanceof Anthropic.AuthenticationError ? 'неверный ключ API'
        : err instanceof Anthropic.RateLimitError ? 'превышен лимит запросов, попробуйте чуть позже'
        : err instanceof Anthropic.APIError ? `ошибка API ${err.status ?? ''}`.trim()
        : 'внутренняя ошибка'
      console.error('[ИИ-ведущий]', err)
      this.ctx.notice(room, `Ведущий недоступен: ${why}.`)
      if (text) this.ctx.chat(room, { id, from: 'gm', author: 'Ведущий', text: text.trim() })
      this.ctx.done(room, id)
      return
    }
    this.ctx.chat(room, { id, from: 'gm', author: 'Ведущий', text: text.trim() || '…' })
    this.ctx.done(room, id)
    this.ctx.stateChanged(room)
    this.ctx.persist(room)
  }
}
