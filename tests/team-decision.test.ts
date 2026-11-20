// Командные решения (server/votes.ts): нажатие кнопки ведущего — предложение, у остальных отсчёт «Согласен / Против»,
// молчание — согласие. ХАУСРУЛ владельца (docs/DECISIONS.md, 2026-11-20).
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { seededRng, setRng } from '@/engine/dice'
import { NetClient } from '@/net/client'
import type { ChatMessage, RoomView } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'
import { REJECT } from '../server/votes'
import { enablePlans } from './plans-on'

const W = world as unknown as WorldMap
let servers: GameServer[] = []
let clients: NetClient[] = []
beforeAll(enablePlans)
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
})

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(15) }
}
function client(s: GameServer) {
  const c = new NetClient(s.url); clients.push(c)
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

/** Двое за столом у сценарного ведущего в режиме «сразу», партия у входа в Золотой город (план размечен) */
async function table(voteMs: number) {
  setRng(seededRng(5))
  const s = await createGameServer({ port: 0, staticDir: null, world: W, voteMs }); servers.push(s)
  const host = client(s), guest = client(s)
  const j = await host.c.create('Иван', 'script')
  await guest.c.join(j.code, 'Пётр')
  await host.c.call('quickStart', [])
  await until(() => guest.state?.heroes.length === 4)
  await host.c.claimHero(host.state.heroes[0].uid)
  await guest.c.claimHero(guest.state.heroes[1].uid)
  await until(() => guest.room?.active.length === 2)
  await host.c.call('enterLocation', ['zolotoy-gorod'])
  await until(() => gm(guest.chat).some((m) => /Вы входите/.test(m.text)))
  const enter = () => gm(guest.chat).find((m) => /Вы входите/.test(m.text))!
  const room = (await s.store.get(j.code))!
  return { s, host, guest, enter, room }
}
const current = (chat: ChatMessage[], id: string) => chat.find((m) => m.id === id)!

describe('командные решения', () => {
  it('молчание — согласие: предложение срабатывает само, когда отсчёт кончился', async () => {
    const t = await table(250)
    const gate = t.enter().choices![0]
    await t.guest.c.choose(t.enter().id, gate.id)
    // предложение видно обоим, идёт отсчёт, партия ещё у входа
    await until(() => !!current(t.host.chat, t.enter().id).votes?.[gate.id])
    const open = current(t.host.chat, t.enter().id)
    expect(open.votes![gate.id].map((v) => v.name)).toEqual(['Пётр'])
    expect(open.voteLeft).toBeGreaterThan(0)
    expect(t.room.state.room ?? null).toBeNull()
    await until(() => t.room.state.room === 40)
    expect(current(t.host.chat, t.enter().id).votes).toBeUndefined()
  })

  it('все согласны — решение сразу, не дожидаясь отсчёта', async () => {
    const t = await table(60_000)
    const gate = t.enter().choices![0]
    await t.guest.c.choose(t.enter().id, gate.id)
    await until(() => !!current(t.host.chat, t.enter().id).votes?.[gate.id])
    expect(t.room.state.room ?? null).toBeNull()
    await t.host.c.choose(t.enter().id, gate.id)
    await until(() => t.room.state.room === 40)
  })

  it('«Против»: при ничьей решает хозяин — его возражение снимает предложение гостя, а возражение гостя хозяину не мешает', async () => {
    const t = await table(60_000)
    const gate = t.enter().choices![0]
    // возражать не на что, пока никто ничего не предложил
    await expect(t.host.c.choose(t.enter().id, REJECT)).rejects.toThrow(/Возражать пока не на что/)
    await t.guest.c.choose(t.enter().id, gate.id)
    await until(() => !!current(t.host.chat, t.enter().id).votes?.[gate.id])
    await t.host.c.choose(t.enter().id, REJECT)
    await until(() => t.host.chat.some((m) => m.from === 'system' && /Команда против \(Иван\)/.test(m.text)))
    expect(t.room.state.room ?? null).toBeNull()
    expect(current(t.host.chat, t.enter().id).votes).toBeUndefined()
    expect(current(t.host.chat, t.enter().id).used ?? []).toEqual([])
    // теперь предлагает хозяин, гость против: ничья — решает голос хозяина
    await t.host.c.choose(t.enter().id, gate.id)
    await until(() => !!current(t.guest.chat, t.enter().id).votes?.[gate.id])
    await t.guest.c.choose(t.enter().id, REJECT)
    await until(() => t.room.state.room === 40)
  })

  it('кнопка выхода на экране локации — тоже предложение команде: голос за этот выход у ведущего', async () => {
    const t = await table(60_000)
    await t.guest.c.move(40)
    await until(() => !!current(t.host.chat, t.enter().id).votes)
    // голос лёг на кнопку «Вперёд: ворота» в сообщении ведущего, партия ждёт
    expect(Object.keys(current(t.host.chat, t.enter().id).votes!)).toEqual([t.enter().choices![0].id])
    expect(t.room.state.room ?? null).toBeNull()
    await t.host.c.choose(t.enter().id, t.enter().choices![0].id)
    await until(() => t.room.state.room === 40)
    // в помещение без прохода — отказ сразу, без голосования
    await t.guest.c.move(24)
    await until(() => gm(t.guest.chat).some((m) => /Из помещения 40 туда прохода нет/.test(m.text)))
    expect(t.room.state.room).toBe(40)
    // голос ложится на самую свежую кнопку этого выхода; второй игрок соглашается там же, где видит предложение
    const open = () => t.guest.chat.find((m) => !!m.votes)
    await t.host.c.move(29)
    await until(() => !!open())
    await t.guest.c.choose(open()!.id, Object.keys(open()!.votes!)[0])
    await until(() => t.room.state.room === 29)
    // вернуться в пройденное помещение: кнопка есть в сообщении о помещении 29 («Назад: улица · § 40»)
    await t.guest.c.move(40)
    await until(() => !!open())
    expect(t.room.state.room).toBe(29)
    await t.host.c.choose(open()!.id, Object.keys(open()!.votes!)[0])
    await until(() => t.room.state.room === 40)
  })

  it('отсчёт выключен (voteMs: 0) — срабатывает первое нажатие; один игрок за столом решает сам', async () => {
    const t = await table(0)
    await t.guest.c.choose(t.enter().id, t.enter().choices![0].id)
    await until(() => t.room.state.room === 40)

    const solo = await table(60_000)
    solo.guest.c.close()
    await until(() => solo.host.room.active.length === 1)
    await solo.host.c.choose(solo.enter().id, solo.enter().choices![0].id)
    await until(() => solo.room.state.room === 40)
  })
})
