// Хранилище комнат: Postgres вместо файлов (хостинг без диска). SQL проверяется на настоящем Postgres в памяти (PGlite).
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { NetClient } from '@/net/client'
import { createGameServer, type GameServer } from '../server/app'
import { RoomStore } from '../server/rooms'
import { PgStorage, type RoomStorage, type SqlClient } from '../server/storage'

const W = world as unknown as WorldMap
let dbs: PGlite[] = []
let servers: GameServer[] = []
let clients: NetClient[] = []

afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  for (const d of dbs) if (!d.closed) await d.close()
  dbs = []; servers = []; clients = []
})

function db(): PGlite {
  const d = new PGlite()
  dbs.push(d)
  return d
}
/** Клиент базы, у которого первые `fails` запросов падают, как при оборванном соединении */
function flaky(inner: SqlClient, fails: number): SqlClient & { calls: number } {
  const c = {
    calls: 0,
    async query(text: string, params?: unknown[]) {
      c.calls++
      if (c.calls <= fails) throw new Error('Connection terminated unexpectedly')
      return inner.query(text, params)
    },
  }
  return c
}
/** Хранилище, которое не отвечает вовсе */
const down: RoomStorage = {
  has: async () => { throw new Error('connect ECONNREFUSED') },
  read: async () => { throw new Error('connect ECONNREFUSED') },
  write: async () => { throw new Error('connect ECONNREFUSED') },
}

describe('комнаты в Postgres', () => {
  it('запись, чтение, перезапись; неизвестной комнаты нет', async () => {
    const st = new PgStorage(db())
    expect(await st.has('ABCDEF')).toBe(false)
    expect(await st.read('ABCDEF')).toBeUndefined()
    // текст хранится как есть: кириллица, кавычки и экранированный нулевой символ (jsonb его не принял бы)
    const json = JSON.stringify({ text: 'Чёрный маг «сказал»: "\u0000" — и исчез', n: 1 })
    await st.write('ABCDEF', json)
    expect(await st.has('ABCDEF')).toBe(true)
    expect(await st.read('ABCDEF')).toBe(json)
    await st.write('ABCDEF', '{"n":2}')
    expect(await st.read('ABCDEF')).toBe('{"n":2}')
    expect(await st.has('ZZZZZZ')).toBe(false)
  })

  it('оборванное соединение: запрос повторяется, таблица создаётся со второй попытки', async () => {
    const client = flaky(db(), 2)
    const st = new PgStorage(client, 3, 1)
    await st.write('ABCDEF', '{}')
    expect(await st.read('ABCDEF')).toBe('{}')
    // база не отвечает дольше, чем длятся попытки, — ошибка доходит до вызывающего
    const dead = new PgStorage(flaky(db(), 100), 3, 1)
    await expect(dead.read('ABCDEF')).rejects.toThrow(/terminated/)
  })

  it('комната переживает перезапуск сервера без диска', async () => {
    const d = db()
    const a = new RoomStore(new PgStorage(d), W)
    const r = await a.create('book')
    r.addPlayer('Иван', true)
    r.addChat({ from: 'player', author: 'Иван', text: 'Идём в Золотой город' })
    a.touch(r)
    await a.flush()

    const b = new RoomStore(new PgStorage(d), W)
    const [x, y] = await Promise.all([b.get(r.code), b.get(r.code)])
    expect(x).toBeDefined()
    expect(x).toBe(y)
    expect(x).not.toBe(r)
    expect([...x!.players.values()].map((p) => p.name)).toEqual(['Иван'])
    expect(x!.chat.at(-1)?.text).toBe('Идём в Золотой город')
    expect(x!.state).toEqual(r.state)
    expect(await b.get('ZZZZZZ')).toBeUndefined()
    // простаивающая комната выгружается из памяти и читается из базы снова
    expect(await b.evictIdle(0, Date.now() + 1)).toBe(1)
    expect(await b.get(r.code)).not.toBe(x)
  })

  it('закрытие сервера дописывает комнаты и закрывает соединение с базой', async () => {
    const d = db()
    let ended = false
    const client: SqlClient = { query: (t, p) => d.query(t, p as unknown[]), end: async () => { ended = true } }
    const s = await createGameServer({ port: 0, staticDir: null, storage: new PgStorage(client), world: W })
    const c = new NetClient(s.url); clients.push(c)
    const j = await c.create('Иван', 'book')
    c.close()
    await s.close()
    expect(ended).toBe(true)
    expect(JSON.parse((await new PgStorage(d).read(j.code))!).players[0].name).toBe('Иван')
  })

  it('база не отвечает: это не «комната не найдена» — клиент не забывает свой вход', async () => {
    const st = new RoomStore(down, W)
    await expect(st.get('ABCDEF')).rejects.toThrow(/попробуйте ещё раз/)
    await expect(st.create('book')).rejects.toThrow(/попробуйте ещё раз/)

    const s = await createGameServer({ port: 0, staticDir: null, storage: down, world: W }); servers.push(s)
    const c = new NetClient(s.url); clients.push(c)
    const err = await c.join('ABCDEF', 'Иван').catch((e: Error) => e.message)
    expect(err).toMatch(/попробуйте ещё раз/)
    expect(err).not.toMatch(/не найдена/)
  })
})
