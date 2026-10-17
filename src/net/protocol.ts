/** Протокол сетевой игры: общие типы клиента и сервера (socket.io). */
import type { GameState } from '@/engine/model'

/** Кто ведёт игру: ИИ-ведущий, сами игроки по Книге Жизни, живой ведущий (хозяин комнаты) */
export type GmMode = 'ai' | 'book' | 'human'

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
  /** на сервере настроен ключ Claude API */
  aiAvailable: boolean
  /** ИИ-ведущий сейчас отвечает */
  gmBusy: boolean
}

export interface ChatMessage {
  id: string
  t: number
  from: 'gm' | 'player' | 'system'
  author: string
  text: string
  /** реплика адресована ведущему (иначе — только игрокам) */
  toGm?: boolean
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
export interface ChatReq { text: string; toGm: boolean }

export interface ServerToClient {
  state: (s: GameState) => void
  room: (r: RoomView) => void
  chat: (m: ChatMessage) => void
  'chat:history': (m: ChatMessage[]) => void
  'gm:delta': (d: { id: string; text: string }) => void
  'gm:done': (d: { id: string }) => void
  notice: (text: string) => void
}

export interface ClientToServer {
  'room:create': (req: CreateRoomReq, ack: (a: Ack) => void) => void
  'room:join': (req: JoinRoomReq, ack: (a: Ack) => void) => void
  'room:setGm': (gm: GmMode, ack: (a: Ack) => void) => void
  'room:loadState': (state: GameState, ack: (a: Ack) => void) => void
  'hero:claim': (heroUid: string, ack: (a: Ack) => void) => void
  'hero:release': (heroUid: string, ack: (a: Ack) => void) => void
  cmd: (req: CmdReq, ack: (a: Ack) => void) => void
  chat: (req: ChatReq, ack: (a: Ack) => void) => void
}

/** Состояние для отправки клиентам: журнал урезан до последних записей */
export function stateForClients(s: GameState, logTail = 150): GameState {
  return { ...s, log: s.log.slice(-logTail) }
}
