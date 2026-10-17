/** Клиент сетевой игры поверх socket.io. */
import { io, type Socket } from 'socket.io-client'
import type { GameState } from '@/engine/model'
import type { Ack, ChatMessage, ClientToServer, GmMode, Joined, RoomView, ServerToClient, TurnMode } from './protocol'

const SESSION_KEY = 'zchm.net.session'

export interface SavedSession { code: string; token: string; name: string; url?: string }

export function savedSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as SavedSession) : null
  } catch {
    return null
  }
}
function saveSession(s: SavedSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch { /* нет хранилища */ }
}

export class NetClient {
  readonly socket: Socket<ServerToClient, ClientToServer>
  private joined: SavedSession | null = null
  private stateCbs: ((s: GameState) => void)[] = []
  private roomCbs: ((r: RoomView) => void)[] = []
  private noticeCbs: ((t: string) => void)[] = []
  private chatCbs: ((m: ChatMessage) => void)[] = []
  private historyCbs: ((m: ChatMessage[]) => void)[] = []
  private updateCbs: ((m: ChatMessage) => void)[] = []
  private deltaCbs: ((d: { id: string; text: string }) => void)[] = []
  private doneCbs: ((d: { id: string }) => void)[] = []

  constructor(url?: string) {
    // по умолчанию — тот же адрес, что у страницы (в dev Vite проксирует /socket.io на сервер)
    this.socket = url ? io(url, { transports: ['websocket', 'polling'] }) : io({ transports: ['websocket', 'polling'] })
    this.socket.on('state', (s) => this.stateCbs.forEach((cb) => cb(s)))
    this.socket.on('room', (r) => this.roomCbs.forEach((cb) => cb(r)))
    this.socket.on('notice', (t) => this.noticeCbs.forEach((cb) => cb(t)))
    this.socket.on('chat', (m) => this.chatCbs.forEach((cb) => cb(m)))
    this.socket.on('chat:history', (m) => this.historyCbs.forEach((cb) => cb(m)))
    this.socket.on('chat:update', (m) => this.updateCbs.forEach((cb) => cb(m)))
    this.socket.on('gm:delta', (d) => this.deltaCbs.forEach((cb) => cb(d)))
    this.socket.on('gm:done', (d) => this.doneCbs.forEach((cb) => cb(d)))
    // после обрыва связи — вернуться в комнату под тем же игроком
    this.socket.io.on('reconnect', () => {
      if (this.joined) void this.join(this.joined.code, this.joined.name, this.joined.token).catch(() => {})
    })
  }

  onState(cb: (s: GameState) => void) { this.stateCbs.push(cb) }
  onRoom(cb: (r: RoomView) => void) { this.roomCbs.push(cb) }
  onNotice(cb: (t: string) => void) { this.noticeCbs.push(cb) }
  onChat(cb: (m: ChatMessage) => void) { this.chatCbs.push(cb) }
  onChatHistory(cb: (m: ChatMessage[]) => void) { this.historyCbs.push(cb) }
  onChatUpdate(cb: (m: ChatMessage) => void) { this.updateCbs.push(cb) }
  onGmDelta(cb: (d: { id: string; text: string }) => void) { this.deltaCbs.push(cb) }
  onGmDone(cb: (d: { id: string }) => void) { this.doneCbs.push(cb) }

  private unwrap<T>(a: Ack<T>): T {
    if (!a.ok) {
      const e = new Error(a.error ?? 'Ошибка сервера')
      e.name = 'GameError'
      throw e
    }
    return a.result as T
  }

  async create(name: string, gm: GmMode, state?: GameState): Promise<Joined> {
    const j = this.unwrap(await this.socket.emitWithAck('room:create', { name, gm, state })) as Joined
    this.joined = { code: j.code, token: j.token, name }
    saveSession(this.joined)
    return j
  }
  async join(code: string, name: string, token?: string): Promise<Joined> {
    const j = this.unwrap(await this.socket.emitWithAck('room:join', { code: code.trim().toUpperCase(), name, token })) as Joined
    this.joined = { code: j.code, token: j.token, name }
    saveSession(this.joined)
    return j
  }
  async call(name: string, args: unknown[]): Promise<unknown> {
    return this.unwrap(await this.socket.emitWithAck('cmd', { name, args }))
  }
  async setGm(gm: GmMode): Promise<void> { this.unwrap(await this.socket.emitWithAck('room:setGm', gm)) }
  async loadState(state: GameState): Promise<void> { this.unwrap(await this.socket.emitWithAck('room:loadState', state)) }
  async claimHero(heroUid: string): Promise<void> { this.unwrap(await this.socket.emitWithAck('hero:claim', heroUid)) }
  async releaseHero(heroUid: string): Promise<void> { this.unwrap(await this.socket.emitWithAck('hero:release', heroUid)) }
  async chat(text: string, toGm: boolean): Promise<boolean> { this.unwrap(await this.socket.emitWithAck('chat', { text, toGm })); return true }
  async choose(messageId: string, choiceId: string): Promise<void> { this.unwrap(await this.socket.emitWithAck('gm:choose', { messageId, choiceId })) }
  async setTurnMode(mode: TurnMode): Promise<void> { this.unwrap(await this.socket.emitWithAck('room:turnMode', mode)) }
  async setReady(ready: boolean): Promise<void> { this.unwrap(await this.socket.emitWithAck('turn:ready', ready)) }
  async turnGo(): Promise<void> { this.unwrap(await this.socket.emitWithAck('turn:go')) }

  /** Выйти из комнаты (забыть сохранённый вход) */
  close(): void {
    this.joined = null
    saveSession(null)
    this.socket.close()
  }
}
