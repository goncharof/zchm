// Возврат в игру: обновление страницы, обрыв связи, другое устройство, перезапуск сервера.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage, RoomView } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'
import { aiGmFactory } from '../server/gm/ai'
import { RoomStore } from '../server/rooms'
import type { LlmProvider } from '../server/gm/types'

const W = world as unknown as WorldMap
let servers: GameServer[] = []
let clients: NetClient[] = []
let dirs: string[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  servers = []; clients = []; dirs = []
})
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait() }
}
function client(s: GameServer) {
  const c = new NetClient(s.url)
  clients.push(c)
  let state: GameState | null = null
  let room: RoomView | null = null
  const chat: ChatMessage[] = []
  const live: Record<string, string> = {}
  c.onState((x) => { state = x })
  c.onRoom((x) => { room = x })
  c.onChat((m) => chat.push(m))
  c.onGmDelta(({ id, text }) => { live[id] = (live[id] ?? '') + text })
  return { c, chat, live, get state() { return state! }, get room() { return room! } }
}

describe('возврат в игру', () => {
  it('вход с другого устройства под своим именем возвращает героев', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), guest = client(s)
    const j = await host.c.create('Иван', 'book')
    await guest.c.join(j.code, 'Пётр')
    await host.c.call('quickStart', [])
    await until(() => guest.state?.heroes.length === 4)
    const merlin = guest.state.heroes[1].uid
    await guest.c.claimHero(merlin)
    guest.c.socket.disconnect() // закрыл вкладку
    await until(() => host.room.players.find((p) => p.name === 'Пётр')?.online === false)
    const phone = client(s)
    await phone.c.join(j.code, 'пётр') // другое устройство, без токена
    await until(() => !!phone.room)
    expect(phone.room.me.heroUids).toEqual([merlin])
    expect(host.room.players).toHaveLength(2)
  })

  it('комнаты не стало, пока ждали связи: экран возврата за стол закрывается', async () => {
    const mem = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
      getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k),
    }
    const { createPinia, setActivePinia } = await import('pinia')
    const { useGameStore } = await import('@/stores/game')
    setActivePinia(createPinia())
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const store = useGameStore()
    const net = new NetClient(s.url); clients.push(net)
    store.attachNet(net)
    await store.createRoom('Иван', 'book', false)
    const code = store.room!.code
    store.rejoinState = 'waiting' // как после входа при лежащем сервере
    ;(s.store as unknown as { rooms: Map<string, unknown> }).rooms.delete(code)
    net.socket.disconnect(); net.socket.connect()
    await until(() => store.net === null)
    expect(store.rejoinState).toBe('idle')
  })

  it('после обрыва связи команда ждёт повторного входа, а не получает «Вы не в комнате»', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const a = client(s)
    await a.c.create('Иван', 'book')
    a.c.socket.disconnect()
    a.c.socket.connect()
    expect(await a.c.call('rollDice', ['1к6'])).toBeTruthy()
  })

  it('обновивший страницу посреди ответа ведущего сразу видит уже написанный текст', async () => {
    let release!: () => void
    const slow: LlmProvider = {
      id: 'slow', label: 'Медленный',
      async turn(_room, _input, io) {
        io.delta('Тяжёлые ворота медленно ')
        await new Promise<void>((r) => { release = r })
        io.delta('открываются.')
        return 'Тяжёлые ворота медленно открываются.'
      },
    }
    const s = await createGameServer({ port: 0, staticDir: null, world: W, gm: aiGmFactory({ providers: [slow], cooldownScale: 0 }) }); servers.push(s)
    const a = client(s)
    const j = await a.c.create('Иван', 'ai')
    await a.c.chat('Идём к воротам', true)
    await until(() => Object.values(a.live).some((t) => t.includes('медленно')))
    const b = client(s) // та же партия, новая вкладка
    await b.c.join(j.code, 'Пётр')
    await until(() => Object.values(b.live).some((t) => t === 'Тяжёлые ворота медленно '))
    release()
    await until(() => b.chat.some((m) => m.text === 'Тяжёлые ворота медленно открываются.'))
  })

  it('перезапуск сервера посреди хода: недописанный ход отрезается, очередь ведущего продолжается', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zchm-rooms-')); dirs.push(dir)
    const st = new RoomStore(dir, W)
    const r = await st.create('ai')
    r.gmHistories.slow = [{ role: 'user', content: 'старый ход' }, { role: 'assistant', content: 'ответ' }, { role: 'user', content: 'недописанный' }]
    r.gmMarks.slow = 2
    r.gmInFlight = [{ kind: 'player', author: 'Иван', text: 'идём дальше' }]
    await st.flush(); await st.save(r)
    const loaded = (await new RoomStore(dir, W).get(r.code))!
    expect(loaded.gmHistories.slow).toHaveLength(2)
    expect(loaded.gmQueue.map((x) => (x.kind === 'player' ? x.text : ''))).toEqual(['идём дальше'])

    // новый сервер на том же каталоге: первый вошедший запускает оставшуюся очередь
    const seen: string[] = []
    const echo: LlmProvider = { id: 'slow', label: 'Эхо', async turn(_room, input) { seen.push(input.userText); return 'Продолжаем.' } }
    const s = await createGameServer({ port: 0, staticDir: null, dataDir: dir, world: W, gm: aiGmFactory({ providers: [echo], cooldownScale: 0 }) }); servers.push(s)
    const a = client(s)
    await a.c.join(r.code, 'Иван')
    await until(() => a.chat.some((m) => m.text === 'Продолжаем.'))
    expect(seen[0]).toContain('идём дальше')
  })
})
