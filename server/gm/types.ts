/** Общие типы ведущих: что сервер даёт ведущему и что ведущий умеет. */
import type { ChatMessage } from '@/net/protocol'
import type { Room } from '../rooms'

/** Событие игры, о котором стоит рассказать */
export interface GmEvent {
  type: 'travel' | 'enter' | 'combatEnd' | 'rest' | 'pass'
  /** исход боя (для combatEnd) */
  outcome?: 'victory' | 'fled' | 'defeat'
  text: string
  /** встречи в пути (номера параграфов главы «Дорога») */
  encounters?: number[]
}

export type GmInput =
  | { kind: 'player'; author: string; text: string; playerId?: string; chatId?: string }
  | { kind: 'event'; event: GmEvent }

export interface GmContext {
  stateChanged(room: Room): void
  roomChanged(room: Room): void
  chat(room: Room, m: Omit<ChatMessage, 'id' | 't'> & { id?: string }): ChatMessage
  updateChat(room: Room, m: ChatMessage): void
  delta(room: Room, id: string, text: string): void
  done(room: Room, id: string): void
  notice(room: Room, text: string): void
  persist(room: Room): void
}

export interface GmDriver {
  /** несколько входов сразу уходят одним ходом */
  enqueue(room: Room, input: GmInput | GmInput[]): void
  /** нажата кнопка-вариант сценарного ведущего */
  choose(room: Room, playerId: string, messageId: string, choiceId: string): void
  /** настроенные модели ИИ по порядку перебора */
  chain(): string[]
  /** дождаться окончания всех ходов (тесты, остановка сервера) */
  idle(): Promise<void>
}

export type GmFactory = (ctx: GmContext) => GmDriver

/** Модель ИИ-ведущего у одного провайдера */
export interface LlmProvider {
  id: string
  label: string
  /**
   * Один ход: история провайдера в room.gmHistories[id] дописывается; при неудаче провайдер обязан
   * откатить свою историю и бросить ProviderError.
   */
  turn(room: Room, input: { userText: string; snapshot: string }, io: { delta(text: string): void; stateChanged(): void }): Promise<string>
}

/** Провайдер недоступен: нет ключа, лимит, сбой. cooldownMs — сколько его не пробовать */
export class ProviderError extends Error {
  /** инструменты, которые прерванный ход уже выполнил (их изменения в игре остались) */
  done: string[] = []
  constructor(message: string, public cooldownMs: number) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Краткая запись выполненного инструмента — для следующей модели, чтобы она не повторила действие */
export function describeTool(name: string, input: unknown): string {
  return `${name} ${JSON.stringify(input ?? {}).slice(0, 160)}`
}
