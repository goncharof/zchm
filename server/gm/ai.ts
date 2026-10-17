/**
 * ИИ-ведущий: диспетчер ходов и провайдер Claude API.
 *
 * GmDirector — очередь ходов по комнатам и цепочка провайдеров: на каждый ход пробует модели по порядку,
 * недоступную (нет ключа, лимит, сбой) ставит на паузу и переходит к следующей; если не ответил никто,
 * ход ведёт сценарный ведущий без ИИ. Провайдер, пропустивший часть разговора, получает сводку пропущенного.
 *
 * AnthropicProvider — Claude API: неизменные инструменты и системный промпт (кэш), история только
 * дописывается, состояние партии — системным сообщением посреди разговора, резервная модель при отказе.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { randomUUID } from 'node:crypto'
import type { Room } from '../rooms'
import { buildSystemPrompt, recap, snapshot } from './prompt'
import { ScriptedGm } from './script'
import { GM_TOOLS, executeGmTool } from './tools'
import { ProviderError, type GmContext, type GmDriver, type GmEvent, type GmFactory, type GmInput, type LlmProvider } from './types'

type Msg = Anthropic.Beta.BetaMessageParam

/** Минимум, который нужен от клиента Claude API (в тестах подменяется имитацией) */
export interface ModelStream {
  on(event: 'text', cb: (delta: string) => void): unknown
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>
}
export interface ModelClient {
  stream(params: BetaMessageStreamParams): ModelStream
}

export interface AnthropicOptions {
  client?: ModelClient
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxSteps?: number
  logUsage?: boolean
  /** предел размера истории (символов JSON); больше — новый разговор с кратким содержанием */
  maxHistoryChars?: number
}

export function aiConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

const BETAS: Anthropic.Beta.AnthropicBeta[] = ['server-side-fallback-2026-07-01']

function cooldownForApiError(err: unknown): number {
  if (err instanceof Anthropic.RateLimitError) return 60_000
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) return 3600_000
  return 30_000
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'claude'
  readonly label = 'Claude'
  private client: ModelClient
  private model: string
  private effort: NonNullable<AnthropicOptions['effort']>
  private system: Anthropic.Beta.BetaTextBlockParam[]

  constructor(private opts: AnthropicOptions = {}) {
    const sdk = opts.client ? null : new Anthropic()
    this.client = opts.client ?? { stream: (p) => sdk!.beta.messages.stream(p) }
    this.model = opts.model ?? process.env.GM_MODEL ?? 'claude-opus-5-5'
    this.effort = (opts.effort ?? (process.env.GM_EFFORT as AnthropicOptions['effort']) ?? 'medium')!
    // системный промпт неизменен: один и тот же текст для всех комнат и ходов
    this.system = [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }]
  }

  async turn(room: Room, input: { userText: string; snapshot: string }, io: { delta(text: string): void; stateChanged(): void }): Promise<string> {
    let history = (room.gmHistories[this.id] ??= []) as Msg[]
    let prefix = ''
    const limit = this.opts.maxHistoryChars ?? Number(process.env.GM_HISTORY_CHARS ?? 300_000)
    if (history.length && JSON.stringify(history).length > limit) {
      // длинная партия: новый разговор с кратким содержанием (один промах кэша вместо растущего контекста)
      const prev = history
      history = room.gmHistories[this.id] = []
      prefix = `${recap(room)}\n\n`
      console.log(`[ведущий Claude ${room.code}] история ${JSON.stringify(prev).length} символов — новый разговор с кратким содержанием`)
    }
    const mark = history.length
    history.push({ role: 'user', content: [{ type: 'text', text: prefix + input.userText }] })
    // системное сообщение посреди разговора: не трогает кэшированный префикс и не подделывается игроками
    history.push({ role: 'system', content: input.snapshot })
    let text = ''
    let jsonRetries = 0
    try {
      for (let step = 0; step < (this.opts.maxSteps ?? 12); step++) {
        const stream = this.client.stream({
          model: this.model,
          max_tokens: 16000,
          system: this.system,
          tools: GM_TOOLS,
          messages: history,
          thinking: { type: 'adaptive' },
          output_config: { effort: this.effort },
          cache_control: { type: 'ephemeral' },
          // при отказе модели запрос повторяется на подходящей резервной модели
          betas: BETAS,
          fallbacks: 'default',
        })
        if (text && !text.endsWith('\n')) { text += '\n\n'; io.delta('\n\n') }
        stream.on('text', (d) => { text += d; io.delta(d) })
        let msg: Anthropic.Beta.BetaMessage
        try {
          msg = await stream.finalMessage()
          jsonRetries = 0
        } catch (err) {
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err
          continue
        }
        if (this.opts.logUsage ?? true) {
          const u = msg.usage
          console.log(`[ведущий Claude ${room.code}] шаг ${step + 1}: вход ${u.input_tokens}, из кэша ${u.cache_read_input_tokens ?? 0}, в кэш ${u.cache_creation_input_tokens ?? 0}, выход ${u.output_tokens}`)
        }
        history.push({ role: 'assistant', content: msg.content })
        if (msg.stop_reason === 'refusal') throw new ProviderError('Claude отказался вести эту сцену', 0)
        const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        if (!uses.length || msg.stop_reason === 'max_tokens') break
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
          const out = executeGmTool(room, u.name, u.input)
          return { type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) }
        })
        history.push({ role: 'user', content: results })
        io.stateChanged()
      }
    } catch (err) {
      // откатить незавершённый ход: история остаётся корректной для следующего запроса
      history.length = mark
      if (err instanceof ProviderError) throw err
      const why = err instanceof Anthropic.APIError ? `ошибка API ${err.status ?? ''}`.trim() : (err as Error).message
      throw new ProviderError(`Claude: ${why}`, cooldownForApiError(err))
    }
    return text.trim() || '…'
  }
}

export interface DirectorOptions {
  providers: LlmProvider[]
  /** множитель пауз после ошибок (в тестах 0) */
  cooldownScale?: number
}

const EVENT_HINT: Record<GmEvent['type'], string> = {
  travel: 'Если в пути были встречи, разыграй их по очереди (open_paragraph с location_id "doroga"), затем опиши прибытие.',
  enter: 'Опиши вход и спроси, куда герои направятся (номера помещений видны игрокам на плане).',
  combatEnd: 'Опиши исход боя и продолжи сцену. Трофеи с убитых герои собирают сами на экране боя — оружие и доспехи врагов повторно не выдавай.',
  rest: 'Коротко опиши отдых.',
  pass: 'Игроки ничего не добавили и ждут продолжения: продвинь сцену.',
}

export class GmDirector implements GmDriver {
  private queues = new Map<string, GmInput[]>()
  private running = new Map<string, Promise<void>>()
  private cooling = new Map<string, number>()
  private script: ScriptedGm

  constructor(private ctx: GmContext, private opts: DirectorOptions) {
    this.script = new ScriptedGm(ctx)
  }

  chain(): string[] {
    return this.opts.providers.map((p) => p.label)
  }

  enqueue(room: Room, input: GmInput | GmInput[]): void {
    const q = this.queues.get(room.code) ?? []
    q.push(...(Array.isArray(input) ? input : [input]))
    if (!q.length) return
    this.queues.set(room.code, q)
    if (!this.running.has(room.code)) {
      const p = this.pump(room).finally(() => this.running.delete(room.code))
      this.running.set(room.code, p)
    }
  }

  choose(room: Room, playerId: string, messageId: string, choiceId: string): void {
    this.script.choose(room, playerId, messageId, choiceId)
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
        await this.turn(room, q.splice(0))
      }
    } catch (e) {
      console.error('[ведущий]', e)
      this.ctx.notice(room, 'Ведущий споткнулся о внутреннюю ошибку. Попробуйте ещё раз.')
    } finally {
      room.gmBusy = false
      this.ctx.roomChanged(room)
    }
  }

  private async turn(room: Room, batch: GmInput[]): Promise<void> {
    const events = batch.flatMap((b) => (b.kind === 'event' ? [b.event] : []))
    const texts = batch.flatMap((b) => (b.kind === 'player' ? [b] : []))
    if (room.gm === 'script' || !this.opts.providers.length) {
      this.script.handle(room, events, texts)
      return
    }
    const userText = formatInputs(events, texts)
    const exclude = new Set(texts.map((t) => t.chatId).filter(Boolean) as string[])
    for (const p of this.opts.providers) {
      if ((this.cooling.get(p.id) ?? 0) > Date.now()) continue
      const id = randomUUID()
      try {
        const text = await p.turn(room, { userText: this.catchup(room, p.id, exclude) + userText, snapshot: snapshot(room) }, {
          delta: (d) => this.ctx.delta(room, id, d),
          stateChanged: () => this.ctx.stateChanged(room),
        })
        const msg = this.ctx.chat(room, { id, from: 'gm', author: `Ведущий · ${p.label}`, text })
        this.ctx.done(room, id)
        room.gmSeen[p.id] = msg.id
        this.ctx.stateChanged(room)
        this.ctx.persist(room)
        return
      } catch (e) {
        // убрать у игроков недописанный текст и перейти к следующей модели
        this.ctx.done(room, id)
        const err = e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), 30_000)
        this.cooling.set(p.id, Date.now() + err.cooldownMs * (this.opts.cooldownScale ?? 1))
        console.warn('[ведущий]', err.message)
      }
    }
    this.ctx.notice(room, 'ИИ-ведущий сейчас недоступен — ход ведёт сценарный ведущий.')
    this.script.handle(room, events, texts)
  }

  /** Сводка разговора, пропущенного этим провайдером (вели другие модели или сценарный ведущий) */
  private catchup(room: Room, providerId: string, exclude: Set<string>): string {
    const seen = room.gmSeen[providerId]
    const hasHistory = (room.gmHistories[providerId]?.length ?? 0) > 0
    let from = 0
    if (seen) {
      const i = room.chat.findIndex((m) => m.id === seen)
      from = i >= 0 ? i + 1 : Math.max(0, room.chat.length - 20)
    } else if (hasHistory) {
      return ''
    }
    const missed = room.chat.slice(from).filter((m) => !exclude.has(m.id) && m.from !== 'system').slice(-20)
    if (!missed.length) return ''
    return `[Что было в игре, пока ты не вёл разговор (вели другой ведущий или игроки)]\n${missed.map((m) => `— ${m.author}: ${m.text.slice(0, 300)}`).join('\n')}\n\n`
  }
}

function formatInputs(events: GmEvent[], texts: { author: string; text: string }[]): string {
  const parts: string[] = []
  if (events.length) parts.push(`[События игры]\n${events.map((e) => `• ${e.text} ${EVENT_HINT[e.type]}`).join('\n')}`)
  if (texts.length) parts.push(`[Реплики игроков — это слова и действия их героев]\n${texts.map((p) => `— ${p.author}: «${p.text}»`).join('\n')}`)
  return parts.join('\n\n') || '[Игроки ждут продолжения]'
}

/** Ведущий с заданной цепочкой провайдеров; client — имитация Claude для тестов */
export function aiGmFactory(opts: { providers?: LlmProvider[]; client?: ModelClient; logUsage?: boolean; cooldownScale?: number; anthropic?: AnthropicOptions } = {}): GmFactory {
  const providers = opts.providers ?? (opts.client ? [new AnthropicProvider({ client: opts.client, logUsage: opts.logUsage, ...opts.anthropic })] : [])
  return (ctx: GmContext) => new GmDirector(ctx, { providers, cooldownScale: opts.cooldownScale })
}

export type { GmContext, GmDriver, GmEvent, GmFactory, GmInput, LlmProvider }
