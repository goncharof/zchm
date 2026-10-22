// Регрессии по второму ревью сервера (2026-10-18).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage, RoomView } from '@/net/protocol'
import { seededRng, setRng } from '@/engine/dice'
import { createGameServer, type GameServer } from '../server/app'
import { RoomStore } from '../server/rooms'

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
  c.onState((x) => { state = x })
  c.onRoom((x) => { room = x })
  c.onChat((m) => chat.push(m))
  c.onChatUpdate((m) => { const i = chat.findIndex((x) => x.id === m.id); if (i >= 0) chat[i] = m })
  return { c, chat, get state() { return state! }, get room() { return room! } }
}
const gm = (chat: ChatMessage[]) => chat.filter((m) => m.from === 'gm')

describe('второе ревью сервера', () => {
  it('огромная формула кубиков отклоняется, а не вешает сервер', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const a = client(s)
    await a.c.create('Иван', 'book')
    await expect(a.c.call('rollDice', ['999999999к6'])).rejects.toThrow(/Слишком большая/)
    await expect(a.c.call('startEncounter', [[{ monsterId: 'ork', count: 100000 }]])).rejects.toThrow(/число монстров/)
    expect(await a.c.call('rollDice', ['2к6'])).toBeTruthy()
  })

  it('устаревший голос при уходе игрока не роняет сервер; кнопки не работают без автоведущего', async () => {
    setRng(seededRng(4))
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), guest = client(s)
    const j = await host.c.create('Иван', 'script')
    await guest.c.join(j.code, 'Пётр')
    await host.c.call('quickStart', [])
    await until(() => guest.state?.heroes.length === 4)
    await host.c.claimHero(host.state.heroes[0].uid)
    await guest.c.claimHero(guest.state.heroes[1].uid)
    await host.c.setTurnMode('ready')
    await host.c.call('enterLocation', ['zolotoy-gorod'])
    await host.c.chat('Помещение 26', true)
    await guest.c.setReady(true)
    await until(() => gm(host.chat).some((m) => /помещение 26/.test(m.text)))
    const msg = gm(host.chat).find((m) => /помещение 26/.test(m.text))!
    const luck = msg.choices!.find((c) => c.label === 'Заплатить 3 монеты')!
    await host.c.choose(msg.id, luck.id) // голос
    await guest.c.releaseHero(guest.state.heroes[1].uid) // голосование выключается — голос решается сразу
    await until(() => gm(host.chat).some((m) => m.text.includes('платит 3 монеты')))
    guest.c.close()
    await wait(100)
    expect((await s.store.get(j.code))!.votes).toEqual({})
    await host.c.setGm('human')
    const other = msg.choices!.find((c) => c.label.startsWith('▸'))!
    await expect(host.c.choose(msg.id, other.id)).rejects.toThrow(/не сценарный/)
  })

  it('«Выйти» освобождает героев; «Ход ведущего» в режиме «сразу» отклоняется', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), guest = client(s)
    const j = await host.c.create('Иван', 'script')
    await guest.c.join(j.code, 'Пётр')
    await host.c.call('quickStart', [])
    await until(() => guest.state?.heroes.length === 4)
    await guest.c.claimHero(guest.state.heroes[1].uid)
    await guest.c.leave()
    await until(() => host.room.players.length === 1)
    expect(host.room.players.flatMap((p) => p.heroUids)).toEqual([])
    await expect(host.c.turnGo()).rejects.toThrow(/сразу/)
  })

  it('одновременная загрузка комнаты даёт один объект; ошибка записи не роняет сервер', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zchm-rooms-')); dirs.push(dir)
    const a = new RoomStore(dir, W)
    const r = await a.create('book')
    await a.flush()
    const b = new RoomStore(dir, W)
    const [x, y] = await Promise.all([b.get(r.code), b.get(r.code)])
    expect(x).toBe(y)
    // каталог данных — файл: запись падает, но процесс жив и ошибка только в журнале
    const bad = path.join(dir, 'not-a-dir'); writeFileSync(bad, 'x')
    const c = new RoomStore(path.join(bad, 'rooms'), W)
    await c.create('book')
    await wait(700) // отложенная запись срабатывает и падает
    await expect(c.flush()).resolves.toBeUndefined()
  })

  it('пустая комната выгружается из памяти и загружается снова', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zchm-rooms-')); dirs.push(dir)
    const st = new RoomStore(dir, W)
    const r = await st.create('book')
    await st.flush()
    expect(await st.evictIdle(0, Date.now() + 1)).toBe(1)
    const again = await st.get(r.code)
    expect(again).toBeDefined()
    expect(again).not.toBe(r)
  })
})
