// Живой ведущий: реплики от имени ведущего доступны только хозяину в режиме «живой ведущий».
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
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

describe('живой ведущий', () => {
  it('хозяин рассказывает от имени ведущего, гость — нет; в других режимах — никто', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap }); servers.push(s)
    const host = new NetClient(s.url), guest = new NetClient(s.url); clients.push(host, guest)
    const seen: ChatMessage[] = []
    guest.onChat((m) => seen.push(m))
    const j = await host.create('Иван', 'human')
    await guest.join(j.code, 'Пётр')
    await host.chat('Скрипит дверь, из темноты тянет холодом.', false, true)
    await until(() => seen.some((m) => m.from === 'gm' && m.author === 'Ведущий · Иван'))
    await expect(guest.chat('Я ведущий!', false, true)).rejects.toThrow(/живой ведущий/)
    await host.setGm('book')
    await expect(host.chat('А теперь?', false, true)).rejects.toThrow(/живой ведущий/)
  })
})
