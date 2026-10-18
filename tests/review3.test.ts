// Регрессии по третьему ревью (2026-10-18): сервер, ведущий, движок.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { idx } from '@/data'
import type { GameState } from '@/engine/model'
import { createHero, gainXp } from '@/engine/character'
import { monsterCast, startCombat } from '@/engine/combat'
import { setRng, seededRng } from '@/engine/dice'
import { GameSession, blankGame } from '@/game/session'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'
import { aiGmFactory } from '../server/gm/ai'
import { OpenAiCompatProvider } from '../server/gm/openai'
import type { LlmProvider } from '../server/gm/types'

const W = world as unknown as WorldMap
let servers: GameServer[] = []
let clients: NetClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
  setRng(seededRng(1))
})
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait() }
}
async function aiRoom(providers: LlmProvider[]) {
  const s = await createGameServer({ port: 0, staticDir: null, world: W, gm: aiGmFactory({ providers, cooldownScale: 0 }) }); servers.push(s)
  const c = new NetClient(s.url); clients.push(c)
  const chat: ChatMessage[] = []; let state: GameState | null = null
  c.onChat((m) => chat.push(m)); c.onState((x) => { state = x })
  const j = await c.create('Иван', 'ai')
  await c.call('quickStart', [])
  await c.call('enterLocation', ['zolotoy-gorod'])
  await s.gm.idle()
  return { s, c, j, chat, get state() { return state! } }
}

describe('третье ревью', () => {
  it('повтор хода после перезапуска знает, что уже выполнено', async () => {
    const seen: string[] = []
    const echo: LlmProvider = { id: 'e', label: 'Эхо', async turn(_r, input) { seen.push(input.userText); return 'Продолжаем.' } }
    const g = await aiRoom([echo])
    const room = (await g.s.store.get(g.j.code))!
    room.gmDone = ['change_money {"hero":"Конан","delta":50}'] // так комната выглядит после падения посреди хода
    g.s.gm.enqueue(room, { kind: 'player', author: 'Иван', text: 'Берём награду' })
    await g.s.gm.idle()
    expect(seen.at(-1)).toContain('уже выполнила в игре: change_money')
    expect(room.gmDone).toEqual([])
  })

  it('заранее открытое помещение отмечается пройденным только после удачного хода; отказ и бой не открывают', async () => {
    const failing: LlmProvider = { id: 'f', label: 'Падает', async turn() { throw new Error('boom') } }
    const g = await aiRoom([failing])
    await g.c.chat('Идём в помещение 1', true)
    await g.s.gm.idle()
    // модель упала — сценарный ведущий показывает помещение как новое
    await until(() => g.chat.some((m) => m.author === 'Ведущий · сценарий' && /помещение 1\./.test(m.text)))
    expect(g.chat.some((m) => /помещение 1 \(вы здесь уже были\)/.test(m.text))).toBe(false)
  })

  it('смена режима на живого ведущего очищает очередь ИИ', async () => {
    let calls = 0
    const slow: LlmProvider = { id: 's', label: 'Медленный', async turn() { calls++; await wait(150); return 'Ответ.' } }
    const g = await aiRoom([slow])
    const room = (await g.s.store.get(g.j.code))!
    calls = 0
    g.s.gm.enqueue(room, { kind: 'player', author: 'Иван', text: 'Первая' })
    g.s.gm.enqueue(room, { kind: 'player', author: 'Иван', text: 'Вторая' })
    await wait(30)
    await g.c.setGm('human')
    await g.s.gm.idle()
    expect(calls).toBe(1)
    expect(room.gmQueue).toEqual([])
  })

  it('отдых и бросок с нечисловыми аргументами не портят партию; войти можно только туда, где стоит партия', () => {
    const s = new GameSession(blankGame(), W)
    s.quickStart()
    s.restAll(undefined as unknown as number)
    expect(Number.isFinite(s.state.day)).toBe(true)
    expect(s.state.heroes.every((h) => Number.isFinite(h.lives) && Number.isFinite(h.money))).toBe(true)
    expect(Number.isFinite(s.rollDie('x' as unknown as number))).toBe(true)
    expect(() => s.enterLocation('zamok-chernogo-maga')).toThrow(/по карте/)
  })

  it('отражённое «Удушье» не действует на монстра выше предела заклинания', () => {
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const m = state.monsters[0]
    m.spells = ['Удушье']; m.mana = 30; m.level = 12
    const w = createHero('Маг', 'mage', idx); gainXp(w, 4000, idx)
    w.buffs.push({ source: 'Отражение магии', stat: 'ward', ward: 'reflect', amount: 12, rounds: -1 })
    setRng(() => 0)
    const log = monsterCast(state, m, [w], idx)!
    expect(log.map((e) => e.text).join(' ')).toContain('слишком силён')
    expect(m.choke).toBeUndefined()
    expect(m.disabled).toBeUndefined()
  })

  it('дневная квота Gemini — пауза до сброса, без ожидания', async () => {
    const body = '[{"error":{"code":429,"message":"Quota exceeded","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"retryDelay":"30s"}]}}]'
    let n = 0
    const f = (async () => { n++; return new Response(body, { status: 429 }) }) as unknown as typeof fetch
    const p = new OpenAiCompatProvider({ id: 'g', label: 'Gemini', baseUrl: 'http://fake', model: 'm', maxRetryWaitMs: 60_000 }, f)
    const g = await aiRoom([p])
    await g.c.chat('Ау', true)
    await g.s.gm.idle()
    expect(n).toBe(2) // вход в город и реплика — по одному запросу, без повтора через 30 с
  })
})
