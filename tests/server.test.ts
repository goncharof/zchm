// Сетевая игра: сервер socket.io + клиенты NetClient.
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

async function server(dataDir: string | null = null) {
  const s = await createGameServer({ port: 0, staticDir: null, dataDir, world: W })
  servers.push(s)
  return s
}
function client(s: GameServer) {
  const c = new NetClient(s.url)
  clients.push(c)
  let state: GameState | null = null
  let room: RoomView | null = null
  const chat: ChatMessage[] = []
  c.onState((x) => { state = x })
  c.onRoom((x) => { room = x })
  c.onChat((m) => chat.push(m))
  return { c, get state() { return state! }, get room() { return room! }, chat }
}
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 2000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20) }
}

describe('сетевая игра', () => {
  it('комната, два игрока, рассылка состояния и права на героев', async () => {
    const s = await server()
    const host = client(s), guest = client(s)
    const j = await host.c.create('Иван', 'book')
    expect(j.code).toMatch(/^[A-Z0-9]{5}$/)
    await guest.c.join(j.code, 'Пётр')
    await until(() => !!guest.state && !!guest.room)
    expect(guest.room.players).toHaveLength(2)

    await host.c.call('quickStart', [])
    await until(() => guest.state.heroes.length === 4)
    const conan = guest.state.heroes[0]
    // герои быстрого старта ничьи: хозяин берёт Конана, гость — Мерлина
    await host.c.claimHero(conan.uid)
    await guest.c.claimHero(guest.state.heroes[1].uid)
    await until(() => host.room.me.heroUids.length === 1 && guest.room.me.heroUids.length === 1)
    await expect(guest.c.claimHero(conan.uid)).rejects.toThrow(/управляет Иван/)

    await expect(guest.c.call('attack', [conan.uid, 'rightHand', 'x'])).rejects.toThrow(/не ваш герой/)
    // в одной команде классы не повторяются (ХАУСРУЛ владельца); разрешить повтор может только хозяин
    await expect(guest.c.call('addHero', ['Боромир', 'warrior'])).rejects.toThrow(/классы не повторяются/)
    await expect(guest.c.call('setAllowDuplicateClasses', [true])).rejects.toThrow(/хозяин/)
    const mine = (await guest.c.call('addHero', ['Арагорн', 'barbarian'])) as { uid: string }
    await until(() => guest.room.me.heroUids.includes(mine.uid))
    await guest.c.call('buyItem', [mine.uid, 'weapon', 'mech-korotkiy', 1])
    await until(() => guest.state.heroes.find((h) => h.uid === mine.uid)!.money === 30)
    // в игре без ведущего проверки удачи делают сами игроки
    const r = (await guest.c.call('luckCheck', [mine.uid, 5])) as { ok: boolean }
    expect(typeof r.ok).toBe('boolean')
    await expect(guest.c.call('nope', [])).rejects.toThrow(/Неизвестная команда/)
    await host.c.call('setAllowDuplicateClasses', [true])
    await guest.c.call('addHero', ['Боромир', 'warrior'])
    await until(() => guest.state.heroes.filter((h) => h.classId === 'warrior').length === 2)
  })

  it('режим живого ведущего: награды выдаёт только хозяин', async () => {
    const s = await server()
    const host = client(s), guest = client(s)
    const { code } = await host.c.create('ГМ', 'human')
    await guest.c.join(code, 'Игрок')
    const h = (await guest.c.call('addHero', ['Боромир', 'warrior'])) as { uid: string }
    await expect(guest.c.call('adjustMoney', [h.uid, 100])).rejects.toThrow(/решает ведущий/)
    await host.c.call('adjustMoney', [h.uid, 100])
    await until(() => guest.state.heroes[0].money === 140)
    await expect(guest.c.setGm('book')).rejects.toThrow(/хозяин/)
    // ИИ-ведущий доступен всегда: без моделей ходы ведёт сценарный ведущий
    await host.c.setGm('ai')
    await until(() => guest.room.gm === 'ai' && guest.room.gmChain.length === 0)
  })

  it('чат, переподключение по токену и сохранение комнаты на диск', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zchm-rooms-'))
    dirs.push(dir)
    const s1 = await server(dir)
    const a = client(s1), b = client(s1)
    const j = await a.c.create('Аня', 'book')
    await b.c.join(j.code, 'Боря')
    await a.c.chat('Привет!', false)
    await until(() => b.chat.some((m) => m.text === 'Привет!'))
    expect(b.chat.find((m) => m.text === 'Привет!')!.author).toBe('Аня')
    await a.c.call('addHero', ['Леголас', 'thief'])
    await s1.store.flush()

    const s2 = await server(dir)
    const again = client(s2)
    const j2 = await again.c.join(j.code, 'Аня', j.token)
    expect(j2.playerId).toBe(j.playerId)
    await until(() => !!again.state && again.state.heroes.length === 1 && !!again.room)
    expect(again.room.me.isHost).toBe(true)
    expect(again.room.me.heroUids).toEqual([again.state.heroes[0].uid])
  })
})

describe('защита сервера', () => {
  it('мусорные сообщения получают отказ, а не роняют сервер; события без подтверждения не ломают обработчик', async () => {
    const s = await server()
    const a = client(s)
    await a.c.create('Аня', 'book')
    const raw = a.c.socket
    const bad = await raw.emitWithAck('cmd', null as never)
    expect(bad).toEqual({ ok: false, error: 'Неверный запрос' })
    const long = await raw.emitWithAck('chat', { text: 'x'.repeat(5000), toGm: false })
    expect(long.ok).toBe(false)
    const untyped = raw as unknown as { emit: (...a: unknown[]) => void }
    untyped.emit('cmd', { name: 'note', args: ['без подтверждения'] })
    untyped.emit('chat', 42)
    await wait(80)
    const ok = await raw.emitWithAck('cmd', { name: 'note', args: ['живой'] })
    expect(ok.ok).toBe(true)
  })

  it('частота реплик ведущему ограничена для каждого игрока', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W, limits: { chat: [100, 100] } })
    servers.push(s)
    const a = client(s)
    await a.c.create('Аня', 'script')
    const results = []
    for (let i = 0; i < 7; i++) results.push(await a.c.socket.emitWithAck('chat', { text: `Реплика ${i}`, toGm: true }))
    expect(results.filter((r) => r.ok)).toHaveLength(4)
    expect(results.at(-1)!.error).toMatch(/не больше 4 реплик/)
    // реплики только игрокам не ограничены лимитом ведущего
    expect((await a.c.socket.emitWithAck('chat', { text: 'Игрокам', toGm: false })).ok).toBe(true)
  })
})
