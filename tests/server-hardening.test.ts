// Сервер, открытый в интернет через туннель: вход по имени, подбор кода, размер сообщений, частота ходов ИИ, лавка.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { RoomView } from '@/net/protocol'
import { NetClient } from '@/net/client'
import { GameSession, blankGame } from '@/game/session'
import { clientAddr, createGameServer, type GameServer } from '../server/app'
import { aiGmFactory } from '../server/gm/ai'
import { changeBudget, executeGmTool } from '../server/gm/tools'
import type { LlmProvider } from '../server/gm/types'

const W = world as unknown as WorldMap
let servers: GameServer[] = []
let clients: NetClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
})
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20) }
}
function client(s: GameServer) {
  const c = new NetClient(s.url); clients.push(c)
  let room: RoomView | null = null
  c.onRoom((r) => { room = r })
  return { c, get room() { return room! } }
}

describe('сервер в интернете', () => {
  it('права хозяина по одному имени не отдаются; игрок, вошедший по имени, получает новый токен', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), guest = client(s)
    const { code } = await host.c.create('Алиса', 'book')
    const g = await guest.c.join(code, 'Боб')
    host.c.socket.disconnect(); guest.c.socket.disconnect()
    await wait(80)
    const thief = client(s)
    await thief.c.join(code, 'алиса')
    await until(() => !!thief.room)
    expect(thief.room.me.isHost).toBe(false)
    const bob = client(s)
    const again = await bob.c.join(code, 'боб')
    expect(again.playerId).toBe(g.playerId)
    expect(again.token).not.toBe(g.token)
  })

  it('второе устройство игрока не отнимает его у первого: телефон после обрыва возвращается к своим героям', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), phone = client(s)
    const { code } = await host.c.create('Алиса', 'book')
    const g = await phone.c.join(code, 'Боб')
    phone.c.socket.disconnect()
    await until(() => host.room.players.find((p) => p.name === 'Боб')?.online === false)
    const laptop = client(s)
    expect((await laptop.c.join(code, 'боб')).playerId).toBe(g.playerId)
    // телефон снова в сети, пока ноутбук за столом: тот же игрок, а не второй «Боб» без героев
    const back = client(s)
    expect((await back.c.join(code, 'Боб', g.token)).playerId).toBe(g.playerId)
    await until(() => host.room.players.length === 2 && host.room.players.filter((p) => p.name === 'Боб').length === 1)
  })

  it('устаревший токен после переподключения заменяется выданным сервером', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), first = client(s)
    const { code } = await host.c.create('Алиса', 'book')
    await first.c.join(code, 'Боб')
    first.c.socket.disconnect()
    const stale = client(s)
    const j = await stale.c.join(code, 'боб')
    stale.c.socket.disconnect()
    // ещё три устройства по имени — токен второго уходит из последних трёх
    for (let i = 0; i < 3; i++) {
      await until(() => host.room.players.find((p) => p.name === 'Боб')?.online === false)
      const d = client(s); await d.c.join(code, 'боб'); d.c.socket.disconnect()
    }
    await until(() => host.room.players.find((p) => p.name === 'Боб')?.online === false)
    const saved = () => (stale.c as unknown as { joined: { token: string } }).joined.token
    expect(saved()).toBe(j.token)
    stale.c.socket.connect()
    await until(() => saved() !== j.token)
    await until(() => host.room.players.find((p) => p.name === 'Боб')?.online === true)
  })

  it('чужие опечатки в коде с того же адреса не мешают вернуться за стол по своему токену', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W, limits: { room: [1000, 1000], badJoin: [3, 1 / 600] } }); servers.push(s)
    const host = client(s)
    const { code } = await host.c.create('Алиса', 'book')
    const bob = client(s)
    const b = await bob.c.join(code, 'Боб')
    bob.c.close()
    for (let i = 0; i < 4; i++) await client(s).c.socket.emitWithAck('room:join', { code: 'ZZZZZZ', name: 'x' })
    const again = client(s)
    expect((await again.c.join(code, 'Боб', b.token)).playerId).toBe(b.playerId)
    // а без токена — ограничение действует
    const a = await client(s).c.socket.emitWithAck('room:join', { code, name: 'Новичок' }) as { ok: boolean; error?: string }
    expect(a.error).toMatch(/неудачных попыток/)
  })

  it('адрес клиента: заголовкам верим только от своего прокси, и только адресу, который он дописал', () => {
    const xff = { 'x-forwarded-for': '6.6.6.6, 1.2.3.4', 'cf-connecting-ip': '7.7.7.7' }
    // напрямую из интернета — заголовки игнорируются
    expect(clientAddr({ address: '9.9.9.9', headers: xff }, false)).toBe('9.9.9.9')
    // cloudflared или Caddy на этой машине — последний адрес X-Forwarded-For
    expect(clientAddr({ address: '127.0.0.1', headers: xff }, false)).toBe('1.2.3.4')
    expect(clientAddr({ address: '::ffff:127.0.0.1', headers: xff }, false)).toBe('1.2.3.4')
    expect(clientAddr({ address: '::1', headers: { 'cf-connecting-ip': '7.7.7.7' } }, false)).toBe('7.7.7.7')
    expect(clientAddr({ address: '127.0.0.1', headers: {} }, false)).toBe('127.0.0.1')
    // Docker, Fly.io: TRUST_PROXY=1
    expect(clientAddr({ address: '172.17.0.1', headers: xff }, true)).toBe('1.2.3.4')
  })

  it('одно соединение, перешедшее к другому игроку, не оставляет прежнего «в сети»', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const host = client(s), walker = client(s)
    const { code } = await host.c.create('Хозяин', 'book')
    await walker.c.join(code, 'Первый')
    await walker.c.socket.emitWithAck('room:join', { code, name: 'Второй' })
    await until(() => host.room?.players.length === 3)
    await until(() => host.room.players.find((p) => p.name === 'Первый')?.online === false)
  })

  it('подбор кода комнаты останавливается по адресу, а не по соединению', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W, limits: { room: [1000, 1000], badJoin: [10, 1 / 30] } }); servers.push(s)
    const errors: string[] = []
    for (let i = 0; i < 14; i++) {
      const c = client(s)
      const a = await c.c.socket.emitWithAck('room:join', { code: `ZZZZ${String(i).padStart(2, '0')}`, name: 'x' }) as { ok: boolean; error?: string }
      errors.push(a.error ?? '')
      c.c.close()
    }
    expect(errors.some((e) => /неудачных попыток/.test(e))).toBe(true)
  })

  it('сообщение больше 20 КБ не обрабатывается', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const c = client(s)
    await c.c.create('Ира', 'book')
    const big = await Promise.race([
      c.c.socket.timeout(800).emitWithAck('chat', { text: 'а'.repeat(30_000), toGm: false }).then(() => 'ответ').catch(() => 'нет ответа'),
      wait(1200).then(() => 'нет ответа'),
    ])
    expect(big).toBe('нет ответа')
  })

  it('события игры будят модель ИИ не чаще предела комнаты', async () => {
    let turns = 0
    const echo: LlmProvider = { id: 'echo', label: 'Эхо', async turn() { turns++; return 'Ладно.' } }
    const s = await createGameServer({ port: 0, staticDir: null, world: W, limits: { cmd: [1000, 1000] }, gm: aiGmFactory({ providers: [echo], cooldownScale: 0 }) }); servers.push(s)
    const c = client(s)
    await c.c.create('Ира', 'ai')
    await c.c.call('quickStart', [])
    for (let i = 0; i < 20; i++) await c.c.call('restAll', [1]).catch(() => null)
    await s.gm.idle()
    expect(turns).toBeLessThanOrEqual(7)
  })

  it('событие сверх предела не пропадает: уходит ведущему, когда предел позволит', async () => {
    const seen: string[] = []
    const echo: LlmProvider = { id: 'echo', label: 'Эхо', async turn(_r, input) { seen.push(input.userText); return 'Ладно.' } }
    const s = await createGameServer({ port: 0, staticDir: null, world: W, limits: { cmd: [1000, 1000], gmEvents: [2, 2] }, gm: aiGmFactory({ providers: [echo], cooldownScale: 0 }) }); servers.push(s)
    const c = client(s)
    await c.c.create('Ира', 'ai')
    await c.c.call('quickStart', [])
    for (let i = 0; i < 6; i++) await c.c.call('restAll', [1])
    const rests = () => seen.join('\n').match(/отдыхает в трактире/g)?.length ?? 0
    await until(() => rests() === 6, 4000)
    await s.gm.idle()
    // отложенные события ушли одним ходом, а не шестью
    expect(seen.length).toBeLessThan(6)
  })

  it('«Готов» раз за разом не будит модель чаще, чем реплики ведущему', async () => {
    let turns = 0
    const echo: LlmProvider = { id: 'echo', label: 'Эхо', async turn() { turns++; return 'Ладно.' } }
    const s = await createGameServer({ port: 0, staticDir: null, world: W, limits: { choose: [1000, 1000] }, gm: aiGmFactory({ providers: [echo], cooldownScale: 0 }) }); servers.push(s)
    const c = client(s)
    await c.c.create('Ира', 'ai')
    const errors: string[] = []
    for (let i = 0; i < 12; i++) {
      const a = await c.c.socket.emitWithAck('turn:ready', true) as { ok: boolean; error?: string }
      if (!a.ok) errors.push(a.error ?? '')
      await s.gm.idle()
    }
    expect(turns).toBeLessThanOrEqual(4)
    expect(errors.at(-1)).toMatch(/не успевает/)
  })

  it('в лавке не купить артефакт, трофей или выдуманную вещь', () => {
    const g = new GameSession(blankGame(), W)
    const h = g.addHero('Вор', 'thief')
    expect(() => g.buyItem(h.uid, 'artifact' as 'item', '7')).toThrow(/товара/)
    expect(() => g.buyItem(h.uid, 'weapon', 'lazernyy-mech')).toThrow(/товара/)
    expect(h.inventory).toEqual([])
    // запись журнала не длиннее 500 знаков
    g.note('я'.repeat(5000))
    expect(g.state.log.at(-1)!.text.length).toBe(500)
  })

  it('изменений игры за ход — не больше бюджета; неудачные вызовы его не тратят', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const c = client(s)
    const { code } = await c.c.create('Ира', 'ai')
    await c.c.call('quickStart', [])
    const room = (await s.store.get(code))!
    room.gmChanges = 0
    const budget = changeBudget(room)
    expect(budget).toBe(Math.max(8, 3 * room.state.heroes.length))
    // опечатка в имени героя бюджет не тратит
    expect(executeGmTool(room, 'change_money', { hero: 'Нектоневедомый', delta: 10 }).isError).toBe(true)
    const results = Array.from({ length: budget + 2 }, () => executeGmTool(room, 'change_money', { hero: room.state.heroes[0].name, delta: 10 }))
    expect(results.filter((r) => !r.isError)).toHaveLength(budget)
    expect(results.at(-1)!.content).toMatch(/Слишком много изменений/)
  })

  it('партия из шести героев: каждый теряет жизнь и получает монеты за один ход', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const c = client(s)
    const { code } = await c.c.create('Ира', 'ai')
    await c.c.call('quickStart', [])
    const room = (await s.store.get(code))!
    while (room.state.heroes.length < 6) room.state.heroes.push({ ...structuredClone(room.state.heroes[0]), uid: `x${room.state.heroes.length}`, name: `Герой${room.state.heroes.length}` })
    room.gmChanges = 0
    const out = room.state.heroes.flatMap((h) => [executeGmTool(room, 'change_lives', { hero: h.name, delta: -1 }), executeGmTool(room, 'change_money', { hero: h.name, delta: 25 })])
    expect(out.filter((r) => r.isError)).toEqual([])
  })
})
