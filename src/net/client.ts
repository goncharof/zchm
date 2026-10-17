/** Клиент сетевой игры поверх socket.io. */
import { io, type Socket } from 'socket.io-client'
import type { GameState } from '@/engine/model'
import type { Ack, ChatMessage, ClientToServer, GmMode, Joined, RoomView, ServerToClient, TurnMode } from './protocol'

const TIMEOUT_MS = 15_000

const SESSION_KEY = 'zchm.net.session'

export interface SavedSession { code: string; token: string; name: string; url?: string }

/** Связь с сервером: online — в комнате, reconnecting — связь пропала, возвращаемся под тем же игроком */
export type NetStatus = 'connecting' | 'online' | 'reconnecting'

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
  private statusCbs: ((s: NetStatus) => void)[] = []
  private lostCbs: ((why: string) => void)[] = []
  /** открыт, когда клиент в комнате; после обрыва закрывается до повторного входа — команды ждут, а не получают «Вы не в комнате» */
  private gate: Promise<void> = Promise.resolve()
  private openGate: (() => void) | null = null

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
    this.socket.on('disconnect', () => {
      if (!this.joined) return
      if (!this.openGate) this.gate = new Promise((resolve) => { this.openGate = resolve })
      this.statusCbs.forEach((cb) => cb('reconnecting'))
    })
    // после обрыва связи — вернуться в комнату под тем же игроком, затем пропустить накопившиеся команды
    this.socket.on('connect', () => {
      const s = this.joined
      if (!s || !this.openGate) return
      void this.joinRaw(s.code, s.name, s.token).then((a) => {
        if (!a.ok) {
          // комнаты больше нет (или сервер её не принял) — не пытаться снова при каждом обновлении страницы
          this.joined = null
          saveSession(null)
          this.lostCbs.forEach((cb) => cb(a.error ?? 'Комната недоступна'))
        } else {
          this.statusCbs.forEach((cb) => cb('online'))
        }
        this.openGate?.(); this.openGate = null
      })
    })
  }

  onStatus(cb: (s: NetStatus) => void) { this.statusCbs.push(cb) }
  onLost(cb: (why: string) => void) { this.lostCbs.push(cb) }

  onState(cb: (s: GameState) => void) { this.stateCbs.push(cb) }
  onRoom(cb: (r: RoomView) => void) { this.roomCbs.push(cb) }
  onNotice(cb: (t: string) => void) { this.noticeCbs.push(cb) }
  onChat(cb: (m: ChatMessage) => void) { this.chatCbs.push(cb) }
  onChatHistory(cb: (m: ChatMessage[]) => void) { this.historyCbs.push(cb) }
  onChatUpdate(cb: (m: ChatMessage) => void) { this.updateCbs.push(cb) }
  onGmDelta(cb: (d: { id: string; text: string }) => void) { this.deltaCbs.push(cb) }
  onGmDone(cb: (d: { id: string }) => void) { this.doneCbs.push(cb) }

  /** Ответ сервера с таймаутом: без связи запрос не висит вечно */
  private async ask<T>(p: Promise<Ack<T>>): Promise<Ack<T>> {
    try { return await p } catch { return { ok: false, error: 'Нет связи с сервером' } }
  }

  /** Дождаться повторного входа после обрыва (не дольше таймаута) */
  private async ready(): Promise<void> {
    await Promise.race([this.gate, new Promise((r) => setTimeout(r, TIMEOUT_MS))])
  }

  private joinRaw(code: string, name: string, token?: string): Promise<Ack> {
    return this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('room:join', { code: code.trim().toUpperCase(), name, token }))
  }

  private unwrap<T>(a: Ack<T>): T {
    if (!a.ok) {
      const e = new Error(a.error ?? 'Ошибка сервера')
      e.name = 'GameError'
      throw e
    }
    return a.result as T
  }

  async create(name: string, gm: GmMode, state?: GameState): Promise<Joined> {
    const j = this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('room:create', { name, gm, state }))) as Joined
    this.joined = { code: j.code, token: j.token, name }
    saveSession(this.joined)
    return j
  }
  async join(code: string, name: string, token?: string): Promise<Joined> {
    const a = await this.joinRaw(code, name, token)
    // комнаты больше нет — забыть сохранённый вход, чтобы обновление страницы не пыталось снова
    if (!a.ok && /не найдена/.test(a.error ?? '')) saveSession(null)
    const j = this.unwrap(a) as Joined
    this.joined = { code: j.code, token: j.token, name }
    saveSession(this.joined)
    return j
  }
  async call(name: string, args: unknown[]): Promise<unknown> {
    await this.ready()
    return this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('cmd', { name, args })))
  }
  async setGm(gm: GmMode): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('room:setGm', gm))) }
  async loadState(state: GameState): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('room:loadState', state))) }
  async claimHero(heroUid: string): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('hero:claim', heroUid))) }
  async releaseHero(heroUid: string): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('hero:release', heroUid))) }
  async chat(text: string, toGm: boolean): Promise<boolean> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('chat', { text, toGm }))); return true }
  async choose(messageId: string, choiceId: string): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('gm:choose', { messageId, choiceId }))) }
  async setTurnMode(mode: TurnMode): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('room:turnMode', mode))) }
  async setReady(ready: boolean): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('turn:ready', ready))) }
  async turnGo(): Promise<void> { await this.ready(); this.unwrap(await this.ask(this.socket.timeout(TIMEOUT_MS).emitWithAck('turn:go'))) }

  /** Выйти из комнаты: сервер освобождает героев (иначе за столом остаётся «призрак») */
  async leave(): Promise<void> {
    if (this.joined && this.socket.connected) await this.ask(this.socket.timeout(3000).emitWithAck('room:leave'))
    this.close()
  }

  /** Отключиться (забыть сохранённый вход) */
  close(): void {
    this.joined = null
    saveSession(null)
    this.socket.close()
  }
}
