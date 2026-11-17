/** Протокол сетевой игры: общие типы клиента и сервера (socket.io). */
import type { GameState } from '@/engine/model'

/**
 * Кто ведёт игру: ИИ-ведущий (цепочка моделей, при недоступности — сценарный), сценарный ведущий без ИИ,
 * сами игроки по Книге Жизни, живой ведущий (хозяин комнаты)
 */
export type GmMode = 'ai' | 'script' | 'book' | 'human'
/** когда ведущий отвечает: сразу на каждую реплику или когда все игроки готовы */
export type TurnMode = 'instant' | 'ready'

/** Кнопка-вариант в сообщении ведущего (сценарный ведущий) */
export interface ChatChoice {
  id: string
  label: string
}

export interface PlayerView {
  id: string
  name: string
  isHost: boolean
  heroUids: string[]
  online: boolean
}

export interface RoomView {
  code: string
  gm: GmMode
  players: PlayerView[]
  me: PlayerView
  /** ИИ-ведущий доступен всегда: без моделей ходы ведёт сценарный ведущий */
  aiAvailable: boolean
  /** настроенные модели ИИ-ведущего по порядку перебора (пусто — только сценарный ведущий) */
  gmChain: string[]
  /** ИИ-ведущий сейчас отвечает */
  gmBusy: boolean
  turnMode: TurnMode
  /** рассказчик ИИ поверх сценарного ведущего включён */
  narrator: boolean
  /** игроки, чьей готовности ждёт ход (в сети и с живыми героями) */
  active: string[]
  /** кто уже готов */
  ready: string[]
  /** сколько реплик ведущему ждут хода */
  held: number
  /** хозяина нет или он давно не в сети — любой игрок может стать хозяином */
  hostAway: boolean
}

export interface ChatMessage {
  id: string
  t: number
  from: 'gm' | 'player' | 'system'
  author: string
  text: string
  /** реплика адресована ведущему (иначе — только игрокам) */
  toGm?: boolean
  /** id игрока-автора (свои реплики и непрочитанное — по id, а не по имени: имена могут совпадать) */
  playerId?: string
  /** варианты действий (сценарный ведущий) */
  choices?: ChatChoice[]
  /** уже выбранные варианты */
  used?: string[]
  /** голоса за варианты (режим «когда все готовы»): id варианта → проголосовавшие */
  votes?: Record<string, { id: string; name: string }[]>
}

export interface Ack<T = unknown> {
  ok: boolean
  result?: T
  error?: string
}

export interface CreateRoomReq { name: string; gm: GmMode; state?: GameState }
export interface JoinRoomReq { code: string; name: string; token?: string }
export interface Joined { code: string; playerId: string; token: string }
export interface CmdReq { name: string; args: unknown[] }
export interface ChatReq { text: string; toGm: boolean; /** живой ведущий (хозяин в режиме «живой ведущий») пишет как ведущий */ asGm?: boolean }

export interface ServerToClient {
  state: (s: GameState) => void
  room: (r: RoomView) => void
  chat: (m: ChatMessage) => void
  'chat:history': (m: ChatMessage[]) => void
  /** сообщение изменилось (выбран вариант) */
  'chat:update': (m: ChatMessage) => void
  'gm:delta': (d: { id: string; text: string }) => void
  'gm:done': (d: { id: string }) => void
  notice: (text: string) => void
}

export interface ClientToServer {
  'room:create': (req: CreateRoomReq, ack: (a: Ack) => void) => void
  'room:join': (req: JoinRoomReq, ack: (a: Ack) => void) => void
  'room:setGm': (gm: GmMode, ack: (a: Ack) => void) => void
  'room:turnMode': (mode: TurnMode, ack: (a: Ack) => void) => void
  'room:narrator': (on: boolean, ack: (a: Ack) => void) => void
  'turn:ready': (ready: boolean, ack: (a: Ack) => void) => void
  'turn:go': (ack: (a: Ack) => void) => void
  'room:leave': (ack: (a: Ack) => void) => void
  'room:claimHost': (ack: (a: Ack) => void) => void
  'room:loadState': (state: GameState, ack: (a: Ack) => void) => void
  'hero:claim': (heroUid: string, ack: (a: Ack) => void) => void
  'hero:release': (heroUid: string, ack: (a: Ack) => void) => void
  cmd: (req: CmdReq, ack: (a: Ack) => void) => void
  chat: (req: ChatReq, ack: (a: Ack) => void) => void
  'gm:choose': (req: { messageId: string; choiceId: string }, ack: (a: Ack) => void) => void
}

/** Состояние для отправки клиентам: журнал урезан до последних записей */
export function stateForClients(s: GameState, logTail = 150): GameState {
  return { ...s, log: s.log.slice(-logTail) }
}
