/** Защита сервера: проверка входящих сообщений по схемам и ограничение частоты запросов. */
import { z } from 'zod'
import { GameError } from '@/game/session'

const GM_MODES = ['ai', 'script', 'book', 'human'] as const
const id = z.string().min(1).max(80)

export const Schemas = {
  create: z.object({ name: z.string().trim().min(1).max(30), gm: z.enum(GM_MODES), state: z.unknown().optional() }),
  join: z.object({ code: z.string().trim().min(4).max(8), name: z.string().trim().min(1).max(30), token: z.string().max(80).optional() }),
  gm: z.enum(GM_MODES),
  turnMode: z.enum(['instant', 'ready']),
  ready: z.boolean(),
  heroUid: id,
  cmd: z.object({ name: z.string().min(1).max(40), args: z.array(z.unknown()).max(8) }),
  chat: z.object({ text: z.string().max(1500), toGm: z.boolean(), asGm: z.boolean().optional() }),
  choose: z.object({ messageId: id, choiceId: id }),
  state: z.record(z.string(), z.unknown()),
}

/** Разобрать входящее сообщение; при несоответствии схеме — понятная ошибка вместо исключения в обработчике */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value)
  if (!r.success) throw new GameError('Неверный запрос')
  return r.data
}

/** Ведро токенов: capacity — запас на всплеск, perSecond — скорость пополнения */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private capacity: number, private perSecond: number) {}

  take(key: string, cost = 1): boolean {
    const now = Date.now()
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSecond)
    b.at = now
    const ok = b.tokens >= cost
    if (ok) b.tokens -= cost
    this.buckets.set(key, b)
    if (this.buckets.size > 5000) this.sweep(now)
    return ok
  }

  /** забыть давно полные вёдра, чтобы карта не росла бесконечно */
  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (b.tokens + ((now - b.at) / 1000) * this.perSecond >= this.capacity) this.buckets.delete(k)
  }
}

export interface Limits {
  /** команды игры с одного соединения */
  cmd: [capacity: number, perSecond: number]
  /** сообщения в чат с одного соединения */
  chat: [number, number]
  /** реплики ведущему от одного игрока (расходуют квоты моделей ИИ) */
  toGm: [number, number]
  /** выбор вариантов сценарного ведущего */
  choose: [number, number]
  /** создание и вход в комнаты с одного соединения */
  room: [number, number]
}

export const DEFAULT_LIMITS: Limits = {
  cmd: [40, 10],
  chat: [6, 0.5],
  toGm: [4, 4 / 60],
  choose: [10, 2],
  room: [5, 1 / 20],
}

export function makeLimiters(limits: Partial<Limits> = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits }
  return {
    cmd: new RateLimiter(...l.cmd),
    chat: new RateLimiter(...l.chat),
    toGm: new RateLimiter(...l.toGm),
    choose: new RateLimiter(...l.choose),
    room: new RateLimiter(...l.room),
  }
}

export function limit(ok: boolean, message: string): void {
  if (!ok) throw new GameError(message)
}
