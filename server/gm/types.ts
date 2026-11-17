/** Общие типы ведущих: что сервер даёт ведущему и что ведущий умеет. */
import type { ChatMessage } from '@/net/protocol'
import type { Room } from '../rooms'

/** Событие игры, о котором стоит рассказать */
export interface GmEvent {
  type: 'travel' | 'enter' | 'combatEnd' | 'rest' | 'pass' | 'spell'
  /** исход боя (для combatEnd) */
  outcome?: 'victory' | 'fled' | 'defeat'
  /** заклинание, которое движок не отыгрывает (для spell): исход решает ведущий */
  spell?: { id: string; name: string; hero: string }
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
  /** продолжить очередь комнаты, оставшуюся с прошлого запуска сервера */
  resume?(room: Room): void
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
  /** Короткий ответ без инструментов и истории (рассказчик поверх сценарного ведущего); ошибка — ProviderError */
  complete?(system: string, user: string, maxTokens: number): Promise<string>
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

/** Краткая запись выполненного инструмента с итогом — следующая модель не повторит действие и узнает, чем оно кончилось
 *  (бросок удачи, кубики). open_paragraph не записывается: он только читает книгу, а следующей модели нужен сам текст */
export function describeTool(name: string, input: unknown, result: string): string | null {
  if (name === 'open_paragraph') return null
  return `${name} ${JSON.stringify(input ?? {}).slice(0, 160)} → ${result.replace(/\s+/g, ' ').slice(0, 240)}`
}
