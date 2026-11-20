// «Отложить игру»: игрок отключается, но место за столом (герои, права хозяина) остаётся до возвращения по токену.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { RoomView } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'

const W = world as unknown as WorldMap
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
  c.onState((x) => { state = x })
  c.onRoom((x) => { room = x })
  return { c, get state() { return state! }, get room() { return room! } }
}

describe('отложить игру', () => {
  it('герои и права хозяина остаются; возврат по токену', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), guest = client(s)
    const j = await host.c.create('Иван', 'script')
    const g = await guest.c.join(j.code, 'Пётр')
    await host.c.call('quickStart', [])
    await until(() => guest.state?.heroes.length === 4)
    const heroUid = guest.state.heroes[1].uid
    await guest.c.claimHero(heroUid)

    guest.c.suspend()
    await until(() => host.room.players.find((p) => p.name === 'Пётр')?.online === false)
    expect(host.room.players.find((p) => p.name === 'Пётр')!.heroUids).toEqual([heroUid])

    host.c.suspend()
    const back = client(s)
    const again = await back.c.join(j.code, 'Иван', j.token)
    await until(() => !!back.room)
    expect(back.room.me.isHost).toBe(true)
    expect(again.token).toBe(j.token)

    const guest2 = client(s)
    await guest2.c.join(j.code, 'Пётр', g.token)
    await until(() => guest2.room?.me.heroUids.length === 1)
    expect(guest2.room.me.heroUids).toEqual([heroUid])
  })
})
