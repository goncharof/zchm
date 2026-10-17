/** Общие типы ведущих: что сервер даёт ведущему и что ведущий умеет. */
import type { ChatMessage } from '@/net/protocol'
import type { Room } from '../rooms'

/** Событие игры, о котором стоит рассказать */
export interface GmEvent {
  type: 'travel' | 'enter' | 'combatEnd' | 'rest'
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
  enqueue(room: Room, input: GmInput): void
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
  constructor(message: string, public cooldownMs: number) {
    super(message)
    this.name = 'ProviderError'
  }
}
