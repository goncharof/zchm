/** Комнаты сетевой игры: состояние, игроки, чат, сохранение на диск. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { GameSession, blankGame, migrate } from '@/game/session'
import type { ChatMessage, GmMode, PlayerView, RoomView, TurnMode } from '@/net/protocol'

/** Реплика ведущему, ждущая хода (режим «по готовности») */
export interface HeldInput {
  author: string
  text: string
  playerId: string
  chatId: string
}

export interface Player {
  id: string
  name: string
  token: string
  isHost: boolean
  heroUids: string[]
  sockets: Set<string>
  /** когда закрылось последнее соединение (для передачи прав хозяина) */
  awaySince?: number
}

/** Хозяин не в сети дольше этого — любой игрок может стать хозяином (иначе комнату без хозяина не настроить) */
export const HOST_AWAY_MS = 2 * 60_000

/** Сериализуемая часть комнаты */
export interface RoomData {
  code: string
  gm: GmMode
  state: GameState
  players: Omit<Player, 'sockets'>[]
  chat: ChatMessage[]
  /** истории разговора ИИ-ведущих по провайдерам (форматы API различаются) */
  gmHistories?: Record<string, unknown[]>
  /** устаревшее поле: история Claude до появления цепочки моделей */
  gmHistory?: unknown[]
  /** последний сообщение чата, которое видел каждый провайдер (для сводки пропущенного) */
  gmSeen?: Record<string, string>
  script?: ScriptState
  turnMode?: TurnMode
  held?: HeldInput[]
  votes?: Record<string, Record<string, string>>
  gmMarks?: Record<string, number>
  gmQueue?: import('./gm/types').GmInput[]
  gmInFlight?: import('./gm/types').GmInput[] | null
  gmDone?: string[]
  choiceActions?: Record<string, ChoiceRecord>
  createdAt: number
  updatedAt: number
}

/** Где сейчас сценарный ведущий: последний открытый параграф */
export interface ScriptState {
  locationId: string | null
  n: number | null
  /** параграф, из которого начат бой: после боя предлагаются его ветки победы или поражения */
  fight?: { loc: string; n: number }
  /** одноразовые действия, которые уже сделаны (награды, броски по списку): повторный вход их не повторяет */
  taken?: string[]
}

/** Действие за кнопкой-вариантом сценарного ведущего (сериализуемое) */
export type ScriptAction = (
  | { t: 'branch'; loc: string; n: number; seg: number }
  | { t: 'roll'; loc: string; n: number; seg: number; block: number }
  | { t: 'luck'; target: number; loc?: string; n?: number; seg?: number }
  | { t: 'penalty'; heroUid: string; kind: 'death' | 'lives' | 'half'; amount?: number }
  | { t: 'fight'; specs: { monsterId: string; count: number }[]; loc?: string; n?: number }
  | { t: 'coins'; amount: number }
  | { t: 'pay'; amount: number }
  | { t: 'bottle'; n: number }
  | { t: 'buy'; bottles: number[]; price: number }
  | { t: 'artifact' }
  | { t: 'scroll'; caster?: 'mage' | 'priest'; level?: number }
  | { t: 'rest' }
  | { t: 'next' }
) & {
  /** ключ одноразового действия (награда, бросок по списку): второй раз не выполняется, даже при повторном входе */
  once?: string
}

export interface ChoiceRecord {
  messageId: string
  action: ScriptAction
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CHAT_CAP = 400

export function newCode(): string {
  const bytes = randomBytes(5)
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

export class Room {
  players = new Map<string, Player>()
  chat: ChatMessage[] = []
  gmHistories: Record<string, unknown[]> = {}
  /** длина истории провайдера в начале идущего хода: если сервер упадёт посреди хода, недописанный ход отрезается */
  gmMarks: Record<string, number> = {}
  /** очередь входов ведущему и ход, который сейчас идёт, — сохраняются, чтобы пережить перезапуск сервера */
  gmQueue: import('./gm/types').GmInput[] = []
  gmInFlight: import('./gm/types').GmInput[] | null = null
  /** инструменты, уже выполненные идущим ходом (переживают перезапуск: повтор хода не выдаст награду второй раз) */
  gmDone: string[] = []
  /** недописанный текст ведущего (стрим): игрок, обновивший страницу, видит его сразу */
  live: Record<string, string> = {}
  gmSeen: Record<string, string> = {}
  script: ScriptState = { locationId: null, n: null }
  choiceActions: Record<string, ChoiceRecord> = {}
  gmBusy = false
  /** ход по готовности: реплики ведущему копятся, пока все активные игроки не готовы */
  turnMode: TurnMode = 'instant'
  held: HeldInput[] = []
  ready = new Set<string>()
  /** голосование за варианты сценарного ведущего: id сообщения → игрок → id варианта */
  votes: Record<string, Record<string, string>> = {}
  createdAt = Date.now()
  updatedAt = Date.now()

  constructor(public code: string, public gm: GmMode, public state: GameState, public world: WorldMap | null) {}

  session(): GameSession {
    return new GameSession(this.state, this.world)
  }

  addPlayer(name: string, isHost: boolean): Player {
    const p: Player = { id: randomUUID(), name: name.trim().slice(0, 30) || 'Игрок', token: randomUUID(), isHost, heroUids: [], sockets: new Set() }
    this.players.set(p.id, p)
    return p
  }
  playerByToken(token: string): Player | undefined {
    return [...this.players.values()].find((p) => p.token === token)
  }
  heroOwned(heroUid: string): boolean {
    return [...this.players.values()].some((p) => p.heroUids.includes(heroUid))
  }
  ownerName(heroUid: string): string | undefined {
    return [...this.players.values()].find((p) => p.heroUids.includes(heroUid))?.name
  }
  /** Убрать у игроков героев, которых больше нет в партии */
  pruneHeroes(): void {
    const alive = new Set(this.state.heroes.map((h) => h.uid))
    for (const p of this.players.values()) p.heroUids = p.heroUids.filter((u) => alive.has(u))
  }

  addChat(m: Omit<ChatMessage, 'id' | 't'> & { id?: string }): ChatMessage {
    const msg: ChatMessage = { id: m.id ?? randomUUID(), t: Date.now(), ...m } as ChatMessage
    this.chat.push(msg)
    if (this.chat.length > CHAT_CAP) {
      const dropped = this.chat.splice(0, this.chat.length - CHAT_CAP)
      const gone = new Set(dropped.map((x) => x.id))
      for (const [cid, rec] of Object.entries(this.choiceActions)) if (gone.has(rec.messageId)) delete this.choiceActions[cid]
      for (const id of gone) delete this.votes[id]
    }
    return msg
  }
  chatById(id: string): ChatMessage | undefined {
    return this.chat.find((m) => m.id === id)
  }

  /** Хозяина нет или он давно не в сети */
  hostAway(now = Date.now()): boolean {
    const host = [...this.players.values()].find((p) => p.isHost)
    return !host || (host.sockets.size === 0 && now - (host.awaySince ?? 0) >= HOST_AWAY_MS)
  }
  /** Передать права хозяина; возвращает прежнего хозяина */
  transferHost(to: Player): Player | undefined {
    const old = [...this.players.values()].find((p) => p.isHost && p !== to)
    if (old) old.isHost = false
    to.isHost = true
    return old
  }

  playerView(p: Player): PlayerView {
    return { id: p.id, name: p.name, isHost: p.isHost, heroUids: [...p.heroUids], online: p.sockets.size > 0 }
  }
  /** Чьей готовности ждёт ход: игроки в сети с живыми героями, а если таких нет — все в сети */
  activePlayers(): Player[] {
    const online = [...this.players.values()].filter((p) => p.sockets.size > 0)
    const alive = new Set(this.state.heroes.filter((h) => !h.status.dead).map((h) => h.uid))
    const withHeroes = online.filter((p) => p.heroUids.some((u) => alive.has(u)))
    return withHeroes.length ? withHeroes : online
  }
  allReady(): boolean {
    const active = this.activePlayers()
    return active.length > 0 && active.every((p) => this.ready.has(p.id))
  }
  view(p: Player, gmChain: string[]): RoomView {
    return {
      code: this.code, gm: this.gm, players: [...this.players.values()].map((x) => this.playerView(x)), me: this.playerView(p), aiAvailable: true, gmChain, gmBusy: this.gmBusy,
      turnMode: this.turnMode, active: this.activePlayers().map((x) => x.id), ready: [...this.ready], held: this.held.length,
      hostAway: this.hostAway(),
    }
  }

  toData(): RoomData {
    return {
      code: this.code, gm: this.gm, state: this.state,
      players: [...this.players.values()].map(({ sockets: _s, ...rest }) => { void _s; return rest }),
      chat: this.chat, gmHistories: this.gmHistories, gmSeen: this.gmSeen, script: this.script, choiceActions: this.choiceActions,
      turnMode: this.turnMode, held: this.held, votes: this.votes,
      gmMarks: this.gmMarks, gmQueue: this.gmQueue, gmInFlight: this.gmInFlight, gmDone: this.gmDone,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
    }
  }
  static fromData(d: RoomData, world: WorldMap | null): Room {
    const r = new Room(d.code, d.gm, migrate(d.state), world)
    // после загрузки все не в сети: отсчёт отсутствия хозяина начинается заново
    for (const p of d.players) r.players.set(p.id, { ...p, sockets: new Set(), awaySince: Date.now() })
    r.chat = d.chat ?? []
    r.gmHistories = d.gmHistories ?? (d.gmHistory?.length ? { claude: d.gmHistory } : {})
    r.gmSeen = d.gmSeen ?? {}
    r.script = d.script ?? { locationId: null, n: null }
    r.choiceActions = d.choiceActions ?? {}
    r.turnMode = d.turnMode ?? 'instant'
    r.held = d.held ?? []
    r.votes = d.votes ?? {}
    // сервер упал посреди хода ведущего: отрезать недописанный ход (иначе API отвергает историю), ход повторится
    for (const [id, mark] of Object.entries(d.gmMarks ?? {})) {
      const h = r.gmHistories[id]
      if (h && h.length > mark) h.length = mark
    }
    r.gmQueue = [...(d.gmInFlight ?? []), ...(d.gmQueue ?? [])]
    r.gmDone = d.gmDone ?? []
    // отправившие отложенные реплики были готовы — после перезапуска сервера тоже
    r.ready = new Set(r.held.map((h) => h.playerId))
    r.createdAt = d.createdAt
    r.updatedAt = d.updatedAt
    return r
  }
}

/** Хранилище комнат в памяти с сохранением в JSON-файлы */
export class RoomStore {
  private rooms = new Map<string, Room>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** загрузки с диска в процессе: два игрока, входящие одновременно, получают один и тот же объект комнаты */
  private loading = new Map<string, Promise<Room | undefined>>()

  constructor(private dir: string | null, private world: WorldMap | null) {}

  async create(gm: GmMode, state?: GameState): Promise<Room> {
    let code = newCode()
    while (this.rooms.has(code) || (this.dir && existsSync(this.file(code)))) code = newCode()
    const room = new Room(code, gm, state ? migrate(state) : blankGame(), this.world)
    this.rooms.set(code, room)
    this.touch(room)
    return room
  }

  async get(code: string): Promise<Room | undefined> {
    const c = code.trim().toUpperCase()
    const cached = this.rooms.get(c)
    if (cached) return cached
    if (!this.dir || !/^[A-Z0-9]{4,8}$/.test(c) || !existsSync(this.file(c))) return undefined
    const pending = this.loading.get(c)
    if (pending) return pending
    const load = (async () => {
      try {
        const data = JSON.parse(await readFile(this.file(c), 'utf8')) as RoomData
        const room = this.rooms.get(c) ?? Room.fromData(data, this.world)
        this.rooms.set(c, room)
        return room
      } catch (e) {
        console.error(`[комнаты] не удалось прочитать ${c}:`, (e as Error).message)
        return undefined
      } finally {
        this.loading.delete(c)
      }
    })()
    this.loading.set(c, load)
    return load
  }

  /** Отметить изменение и сохранить на диск с задержкой */
  touch(room: Room): void {
    room.updatedAt = Date.now()
    if (!this.dir) return
    clearTimeout(this.timers.get(room.code))
    this.timers.set(room.code, setTimeout(() => {
      this.timers.delete(room.code)
      // ошибка записи (диск полон, нет прав) не должна ронять сервер
      this.save(room).catch((e) => console.error(`[комнаты] не удалось сохранить ${room.code}:`, (e as Error).message))
    }, 500))
  }

  /** Запись через временный файл: обрыв посреди записи не портит сохранённую комнату */
  async save(room: Room): Promise<void> {
    if (!this.dir) return
    await mkdir(this.dir, { recursive: true })
    const file = this.file(room.code)
    await writeFile(`${file}.tmp`, JSON.stringify(room.toData()))
    await rename(`${file}.tmp`, file)
  }

  async flush(): Promise<void> {
    for (const [code, t] of this.timers) {
      clearTimeout(t)
      const r = this.rooms.get(code)
      if (r) await this.save(r).catch((e) => console.error(`[комнаты] не удалось сохранить ${code}:`, (e as Error).message))
    }
    this.timers.clear()
  }

  /** Выгрузить из памяти комнаты, где давно никого нет (они сохранены на диске и загрузятся при входе) */
  async evictIdle(maxIdleMs: number, now = Date.now()): Promise<number> {
    if (!this.dir) return 0
    let n = 0
    for (const [code, r] of this.rooms) {
      const online = [...r.players.values()].some((p) => p.sockets.size > 0)
      if (online || r.gmBusy || this.timers.has(code) || now - r.updatedAt < maxIdleMs) continue
      try { await this.save(r) } catch { continue }
      // пока сохранялись, кто-то мог войти или комната изменилась
      const stillIdle = ![...r.players.values()].some((p) => p.sockets.size > 0) && !r.gmBusy && !this.timers.has(code) && now - r.updatedAt >= maxIdleMs
      if (!stillIdle || this.rooms.get(code) !== r) continue
      this.rooms.delete(code)
      n++
    }
    return n
  }

  private file(code: string): string {
    return path.join(this.dir!, `${code}.json`)
  }
}
