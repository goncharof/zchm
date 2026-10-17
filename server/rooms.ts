/** Комнаты сетевой игры: состояние, игроки, чат, сохранение на диск. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { GameSession, blankGame, migrate } from '@/game/session'
import type { ChatMessage, GmMode, PlayerView, RoomView } from '@/net/protocol'

export interface Player {
  id: string
  name: string
  token: string
  isHost: boolean
  heroUids: string[]
  sockets: Set<string>
}

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
}

/** Действие за кнопкой-вариантом сценарного ведущего (сериализуемое) */
export type ScriptAction =
  | { t: 'branch'; loc: string; n: number; seg: number }
  | { t: 'roll'; loc: string; n: number; seg: number; block: number }
  | { t: 'luck'; target: number; loc?: string; n?: number; seg?: number }
  | { t: 'penalty'; heroUid: string; kind: 'death' | 'lives' | 'half'; amount?: number }
  | { t: 'fight'; specs: { monsterId: string; count: number }[] }
  | { t: 'coins'; amount: number }
  | { t: 'pay'; amount: number }
  | { t: 'bottle'; n: number }
  | { t: 'artifact' }
  | { t: 'scroll'; caster?: 'mage' | 'priest'; level?: number }
  | { t: 'rest' }
  | { t: 'next' }

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
  gmSeen: Record<string, string> = {}
  script: ScriptState = { locationId: null, n: null }
  choiceActions: Record<string, ChoiceRecord> = {}
  gmBusy = false
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
    }
    return msg
  }
  chatById(id: string): ChatMessage | undefined {
    return this.chat.find((m) => m.id === id)
  }

  playerView(p: Player): PlayerView {
    return { id: p.id, name: p.name, isHost: p.isHost, heroUids: [...p.heroUids], online: p.sockets.size > 0 }
  }
  view(p: Player, gmChain: string[]): RoomView {
    return { code: this.code, gm: this.gm, players: [...this.players.values()].map((x) => this.playerView(x)), me: this.playerView(p), aiAvailable: true, gmChain, gmBusy: this.gmBusy }
  }

  toData(): RoomData {
    return {
      code: this.code, gm: this.gm, state: this.state,
      players: [...this.players.values()].map(({ sockets: _s, ...rest }) => { void _s; return rest }),
      chat: this.chat, gmHistories: this.gmHistories, gmSeen: this.gmSeen, script: this.script, choiceActions: this.choiceActions,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
    }
  }
  static fromData(d: RoomData, world: WorldMap | null): Room {
    const r = new Room(d.code, d.gm, migrate(d.state), world)
    for (const p of d.players) r.players.set(p.id, { ...p, sockets: new Set() })
    r.chat = d.chat ?? []
    r.gmHistories = d.gmHistories ?? (d.gmHistory?.length ? { claude: d.gmHistory } : {})
    r.gmSeen = d.gmSeen ?? {}
    r.script = d.script ?? { locationId: null, n: null }
    r.choiceActions = d.choiceActions ?? {}
    r.createdAt = d.createdAt
    r.updatedAt = d.updatedAt
    return r
  }
}

/** Хранилище комнат в памяти с сохранением в JSON-файлы */
export class RoomStore {
  private rooms = new Map<string, Room>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

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
    const data = JSON.parse(await readFile(this.file(c), 'utf8')) as RoomData
    const room = Room.fromData(data, this.world)
    this.rooms.set(c, room)
    return room
  }

  /** Отметить изменение и сохранить на диск с задержкой */
  touch(room: Room): void {
    room.updatedAt = Date.now()
    if (!this.dir) return
    clearTimeout(this.timers.get(room.code))
    this.timers.set(room.code, setTimeout(() => { void this.save(room) }, 500))
  }

  async save(room: Room): Promise<void> {
    if (!this.dir) return
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(room.code), JSON.stringify(room.toData()))
  }

  async flush(): Promise<void> {
    for (const [code, t] of this.timers) {
      clearTimeout(t)
      const r = this.rooms.get(code)
      if (r) await this.save(r)
    }
    this.timers.clear()
  }

  private file(code: string): string {
    return path.join(this.dir!, `${code}.json`)
  }
}
