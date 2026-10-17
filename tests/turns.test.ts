// Ход по готовности: реплики копятся, ведущий отвечает, когда готовы все активные игроки.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage, RoomView } from '@/net/protocol'
import { seededRng, setRng } from '@/engine/dice'
import { createGameServer, type GameServer } from '../server/app'

let servers: GameServer[] = []
let clients: NetClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
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
  return { c, chat, get state() { return state! }, get room() { return room! } }
}
const gmMessages = (chat: ChatMessage[]) => chat.filter((m) => m.from === 'gm')

async function table() {
  setRng(seededRng(3))
  const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap })
  servers.push(s)
  const host = client(s), guest = client(s)
  const j = await host.c.create('Иван', 'script')
  await guest.c.join(j.code, 'Пётр')
  await host.c.call('quickStart', [])
  await until(() => guest.state?.heroes.length === 4)
  await host.c.claimHero(host.state.heroes[0].uid)
  await guest.c.claimHero(guest.state.heroes[1].uid)
  await host.c.setTurnMode('ready')
  await until(() => guest.room?.turnMode === 'ready')
  await host.c.call('enterLocation', ['zolotoy-gorod'])
  // событие игры не ждёт готовности
  await until(() => gmMessages(guest.chat).some((m) => /Назовите номер/.test(m.text)))
  return { s, host, guest, j }
}

describe('ход по готовности', () => {
  it('ведущий отвечает, когда реплики прислали все активные игроки, и одним ходом', async () => {
    const { host, guest } = await table()
    const before = gmMessages(guest.chat).length
    await host.c.chat('Идём в помещение 1', true)
    await until(() => guest.room.held === 1 && guest.room.ready.length === 1)
    await wait(100)
    expect(gmMessages(guest.chat)).toHaveLength(before) // ждём Петра
    expect(guest.room.active).toHaveLength(2)
    await guest.c.chat('Я прикрываю тыл', true)
    await until(() => gmMessages(guest.chat).some((m) => /помещение 1/.test(m.text)))
    await until(() => guest.room.held === 0 && guest.room.ready.length === 0)
  })

  it('«Готов» без реплики и «Ход ведущего» от хозяина; гость начать ход не может', async () => {
    const { host, guest } = await table()
    await host.c.setReady(true)
    await guest.c.setReady(true)
    await until(() => gmMessages(guest.chat).some((m) => m.text.startsWith('Все готовы')))
    await expect(guest.c.turnGo()).rejects.toThrow(/хозяин/)
    const n = gmMessages(guest.chat).length
    await host.c.chat('Помещение 3', true)
    await host.c.turnGo()
    await until(() => gmMessages(guest.chat).length > n && /помещение 3/.test(gmMessages(guest.chat).at(-1)!.text))
  })

  it('ушедший игрок не задерживает ход; режим «сразу» отправляет накопленное', async () => {
    const { host, guest } = await table()
    await host.c.chat('Помещение 5', true)
    await until(() => host.room.held === 1)
    guest.c.close()
    await until(() => gmMessages(host.chat).some((m) => /помещение 5/.test(m.text)))
    await host.c.chat('Помещение 7', true)
    await host.c.setTurnMode('instant')
    await until(() => gmMessages(host.chat).some((m) => /помещение 7/.test(m.text)))
    await host.c.chat('Помещение 8', true)
    await until(() => gmMessages(host.chat).some((m) => /помещение 8/.test(m.text)))
  })
})
