// Планы локаций: по локации идут из помещения в соседнее (ХАУСРУЛ, src/engine/plans.ts).
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import world from '@/data/world.json'
import { gameData, idx } from '@/data'
import type { WorldMap } from '@/types'
import { describeExits, lookAround, reachable, relative, roomOf, sideBetween, whyBlocked } from '@/engine/plans'
import { GameSession, blankGame } from '@/game/session'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'
import { paragraphPayload } from '../server/gm/tools'
import { snapshot } from '../server/gm/prompt'
import { buildPlan } from '../tools/build_plans'
import { enablePlans } from './plans-on'

const W = world as unknown as WorldMap
const GOLD = 'zolotoy-gorod'
beforeAll(enablePlans)

let servers: GameServer[] = []
let clients: NetClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
})

function inGold(): GameSession {
  const s = new GameSession(blankGame(GOLD), W)
  s.quickStart()
  s.enterLocation(GOLD)
  return s
}

describe('разметка планов', () => {
  const dir = path.resolve(__dirname, '..', 'tools', 'plans')
  const ids = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

  it('каждый размеченный план проходит проверку: все помещения на месте и достижимы от входа', () => {
    expect(ids).toContain(GOLD)
    for (const id of ids) {
      const { plan, errors } = buildPlan(JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')))
      expect(errors, id).toEqual([])
      expect(reachable(plan).size, id).toBe(plan.rooms.length)
    }
  })

  it('src/data/plans.json собран из текущей разметки (pnpm data:plans)', () => {
    for (const p of gameData.plans ?? []) {
      const { plan } = buildPlan(JSON.parse(readFileSync(path.join(dir, `${p.id}.json`), 'utf8')))
      expect(p, p.id).toEqual(plan)
    }
    expect((gameData.plans ?? []).map((p) => p.id).sort()).toEqual([...ids].sort())
  })

  it('выход в обратную сторону смотрит в противоположную сторону, лестница вверх — вниз', () => {
    const plan = idx.planById.get(GOLD)!
    expect(roomOf(plan, 40)!.exits.find((e) => e.to === 34)).toMatchObject({ side: 'W', via: 'дверь башни' })
    expect(roomOf(plan, 34)!.exits.find((e) => e.to === 40)).toMatchObject({ side: 'E' })
    expect(roomOf(plan, 34)!.exits.find((e) => e.to === 2)).toMatchObject({ side: 'U' })
    expect(roomOf(plan, 2)!.exits.find((e) => e.to === 34)).toMatchObject({ side: 'D' })
  })
})

describe('стороны и подсказки', () => {
  it('сторона между точками плана и поворот относительно взгляда', () => {
    expect(sideBetween({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe('N')
    expect(sideBetween({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe('SE')
    expect(relative('N', 'E')).toBe('R')
    expect(relative('E', 'N')).toBe('L')
    expect(relative('S', 'N')).toBe('B')
    expect(relative('W', 'NW')).toBe('FR')
    expect(relative('N', 'U')).toBe('U')
  })

  it('у входа видны ворота; на улице — что впереди, справа и слева; одинаковые двери различаются порядком', () => {
    const plan = idx.planById.get(GOLD)!
    expect(describeExits(lookAround(plan, null, 'N'))).toBe('Впереди ворота.')
    const street = lookAround(plan, 40, 'N', [40])
    // открытый путь называется по месту, куда ведёт; дверь — дверью; номера непройденных помещений не названы
    expect(street.find((e) => e.to === 29)).toMatchObject({ what: 'улица', known: false })
    expect(street.find((e) => e.to === 34)).toMatchObject({ rel: 'L', what: 'дверь башни' })
    expect(street.find((e) => e.to === 13)).toMatchObject({ rel: 'R', what: 'дверь башни' })
    expect(describeExits(street)).not.toMatch(/§/)
    const square = lookAround(plan, 41, 'N', [40, 29, 41])
    expect(square.filter((e) => e.rel === 'F').map((e) => e.what)).toEqual(['первая дверь замка', 'вторая дверь замка', 'третья дверь замка'])
    // пройденное помещение названо номером
    expect(describeExits(square)).toMatch(/улица \(§ 29\)/)
  })
})

describe('перемещение по плану', () => {
  it('от входа — только в ворота; дальше — в соседнее помещение; в глубину замка сразу не попасть', () => {
    const s = inGold()
    expect(s.state.room).toBeNull()
    expect(() => s.moveTo(1)).toThrow(/у входа/)
    s.moveTo(40)
    expect(s.state.room).toBe(40)
    expect(s.state.visited[GOLD]).toEqual([40])
    expect(() => s.moveTo(1)).toThrow(/прохода нет/)
    expect(() => s.moveTo(41)).toThrow(/прохода нет/)
    s.moveTo(29)
    s.moveTo(41)
    // партия смотрит туда, куда шла: с улицы 29 на площадь 41 — на север
    expect(s.state.heading).toBe('N')
    s.moveTo(18)
    expect(s.state.visited[GOLD]).toEqual([40, 29, 41, 18])
  })

  it('в пройденное помещение можно вернуться откуда угодно; ведущий ходит свободно; покинув локацию, партия снова у входа', () => {
    const s = inGold()
    s.moveTo(40); s.moveTo(29); s.moveTo(41)
    s.moveTo(40)
    expect(s.state.room).toBe(40)
    expect(() => s.moveTo(24)).toThrow(/прохода нет/)
    s.toggleGm()
    s.moveTo(24)
    expect(s.state.room).toBe(24)
    s.toggleGm()
    s.leaveLocation()
    expect(s.state.room).toBeNull()
    s.enterLocation(GOLD)
    expect(s.state.room).toBeNull()
    expect(s.state.heading).toBe('N')
    // вернуться в пройденное можно и от входа
    s.moveTo(41)
    expect(s.state.room).toBe(41)
  })

  it('куда отправляет книга — туда можно и не по соседству: грифон уносит из галереи 35 на площадь 41', () => {
    const plan = idx.planById.get(GOLD)!
    expect(whyBlocked(plan, { room: 35, visited: [40, 13, 35] }, 41)).toMatch(/прохода нет/)
    const s = inGold()
    s.moveTo(40); s.moveTo(13); s.moveTo(35)
    s.moveTo(41)
    expect(s.state.room).toBe(41)
  })

  it('во время боя из помещения не уйти', () => {
    const s = inGold()
    s.moveTo(40)
    s.startEncounter([{ monsterId: idx.data.bestiary.find((m) => !m.special)!.id, count: 1 }])
    expect(() => s.moveTo(29)).toThrow()
    expect(s.state.room).toBe(40)
  })

  it('локация без размеченного плана и глава «Дорога» — по номеру, как раньше', () => {
    idx.planById.delete(GOLD)
    try {
      const s = inGold()
      s.moveTo(24)
      expect(s.state.room).toBe(24)
    } finally { enablePlans() }
  })
})

describe('двор без номера и скрытый путь', () => {
  const FORT = 'severnyy-fort'
  const fortNode = W.nodes.find((n) => n.locationId === FORT)!

  it('Северный форт: ворота ведут во двор — место без параграфа; из двора видны двери и соседние дворы', () => {
    const s = new GameSession(blankGame(fortNode.id), W)
    s.quickStart()
    s.setStart(fortNode.id)
    s.enterLocation(FORT)
    const plan = idx.planById.get(FORT)!
    const gate = lookAround(plan, null, s.state.heading)
    expect(gate).toHaveLength(1)
    expect(gate[0]).toMatchObject({ what: 'ворота' })
    expect(gate[0].to).toBeLessThan(0)
    s.moveTo(gate[0].to)
    expect(s.state.room).toBe(gate[0].to)
    const yard = lookAround(plan, s.state.room, s.state.heading, s.state.visited[FORT])
    expect(yard.some((e) => e.what.includes('дверь'))).toBe(true)
    expect(yard.some((e) => /двор|переулок/.test(e.what))).toBe(true)
    // у двора нет параграфа: номером его не называют, даже когда партия там была
    expect(describeExits(lookAround(plan, yard.find((e) => e.to > 0)!.to, 'N', s.state.visited[FORT]))).not.toMatch(/§ -/)
    // из двора в здание и обратно
    const door = yard.find((e) => e.to > 0)!
    s.moveTo(door.to)
    expect(s.state.room).toBe(door.to)
    s.moveTo(gate[0].to)
    expect(s.state.room).toBe(gate[0].to)
  })

  it('Замок жрецов: провал из 7 в 17 партия не видит и сама туда не идёт — туда её отправляет текст книги', () => {
    const plan = idx.planById.get('zamok-zhretsov')!
    expect(roomOf(plan, 7)!.exits.find((e) => e.to === 17)).toMatchObject({ hidden: true })
    expect(lookAround(plan, 7, 'N', [7]).some((e) => e.to === 17)).toBe(false)
    expect(whyBlocked(plan, { room: 7, visited: [7] }, 17)).toMatch(/прохода нет/)
    // переход из § 7 записан в дереве книги — он разрешён
    expect(whyBlocked(plan, { room: 7, visited: [7] }, 17, [17])).toBeNull()
  })
})

describe('ведущие ходят по плану', () => {
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))
  async function until(fn: () => boolean, ms = 3000) {
    const t = Date.now()
    while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20) }
  }
  async function table() {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const c = new NetClient(s.url); clients.push(c)
    const chat: ChatMessage[] = []
    c.onChat((m) => chat.push(m))
    c.onChatUpdate((m) => { const i = chat.findIndex((x) => x.id === m.id); if (i >= 0) chat[i] = m })
    const j = await c.create('Иван', 'script')
    await c.call('quickStart', [])
    await c.call('enterLocation', [GOLD])
    const room = (await s.store.get(j.code))!
    const gm = () => chat.filter((m) => m.from === 'gm')
    return { s, c, chat, room, gm }
  }

  it('сценарный ведущий: при входе называет выходы, в дальнее помещение не пускает, по кнопке и по словам ведёт в соседнее', async () => {
    const t = await table()
    await until(() => t.gm().some((m) => /Вы входите/.test(m.text)))
    const enter = t.gm().find((m) => /Вы входите/.test(m.text))!
    expect(enter.text).toMatch(/Впереди ворота/)
    expect(enter.choices?.map((x) => x.label)).toEqual(['🚪 Вперёд: ворота'])

    await t.c.chat('Идём в помещение 1.', true)
    await until(() => t.gm().some((m) => /у входа/.test(m.text)))
    expect(t.room.state.room ?? null).toBeNull()

    // кнопка выхода
    await t.c.choose(enter.id, enter.choices![0].id)
    await until(() => t.room.state.room === 40)
    await until(() => t.gm().some((m) => /помещение 40/.test(m.text)))
    const street = t.gm().find((m) => /помещение 40/.test(m.text))!
    expect(street.text).toMatch(/улица/)
    expect(street.choices?.some((x) => /🚪 .*улица/.test(x.label))).toBe(true)
    // номера непройденных помещений в подписях выходов не названы
    expect(street.choices!.filter((x) => x.label.startsWith('🚪')).every((x) => !/§/.test(x.label))).toBe(true)

    await t.c.chat('Идём в помещение 24.', true)
    await until(() => t.gm().some((m) => /Из помещения 40 туда прохода нет/.test(m.text)))
    expect(t.room.state.room).toBe(40)

    // словами: слева от ворот — дверь башни (помещение 34)
    await t.c.chat('идём налево', true)
    await until(() => t.room.state.room === 34)
    // «где мы» не перечисляет непройденные номера
    await t.c.chat('где мы?', true)
    await until(() => t.gm().some((m) => /Пройдено 2 из 41\./.test(m.text)))
    expect(t.gm().find((m) => /Пройдено 2 из 41\./.test(m.text))!.text).not.toMatch(/не пройдены/)
  })

  it('двор без номера: сценарный ведущий называет место и выходы, ИИ-ведущему отдаёт место без параграфа', async () => {
    const s = await createGameServer({ port: 0, staticDir: null, world: W }); servers.push(s)
    const c = new NetClient(s.url); clients.push(c)
    const chat: ChatMessage[] = []
    c.onChat((m) => chat.push(m))
    const j = await c.create('Иван', 'script')
    await c.call('quickStart', [])
    await c.call('setStart', [W.nodes.find((n) => n.locationId === 'severnyy-fort')!.id])
    await c.call('enterLocation', ['severnyy-fort'])
    const room = (await s.store.get(j.code))!
    await until(() => chat.some((m) => m.from === 'gm' && /Вы входите/.test(m.text)))
    const enter = chat.find((m) => m.from === 'gm' && /Вы входите/.test(m.text))!
    await c.choose(enter.id, enter.choices![0].id)
    await until(() => (room.state.room ?? 0) < 0)
    await until(() => chat.some((m) => m.from === 'gm' && /^Двор у ворот\./.test(m.text)))
    const yard = chat.find((m) => m.from === 'gm' && /^Двор у ворот\./.test(m.text))!
    expect(yard.choices!.length).toBeGreaterThan(3)
    expect(yard.text).not.toMatch(/§ -/)
    // «где мы» называет двор, а не «помещение -1»
    await c.chat('где мы?', true)
    await until(() => chat.some((m) => m.from === 'gm' && /двор у ворот, день/.test(m.text)))
    // ИИ-ведущему: место без параграфа и его выходы
    const payload = JSON.parse(paragraphPayload(room, 'severnyy-fort', room.state.room!)) as { место: string; параграфа_нет: boolean; выходы: unknown[] }
    expect(payload).toMatchObject({ место: 'двор у ворот', параграфа_нет: true })
    expect(payload.выходы.length).toBeGreaterThan(3)
    expect(snapshot(room)).toMatch(/в месте без параграфа \(двор у ворот/)
  })

  it('ИИ-ведущий: open_paragraph не открывает помещение без прохода и отдаёт выходы; в снимке — где партия и что вокруг', async () => {
    const t = await table()
    expect(() => paragraphPayload(t.room, GOLD, 24)).toThrow(/у входа.*Выходы отсюда: впереди — ворота \(§ 40\)/)
    const opened = JSON.parse(paragraphPayload(t.room, GOLD, 40)) as { выходы: { куда: string; что: string; параграф: number; пройдено: boolean }[] }
    expect(opened.выходы.find((e) => e.параграф === 29)).toMatchObject({ что: 'улица', пройдено: false })
    t.room.session().placeIn(40)
    expect(() => paragraphPayload(t.room, GOLD, 24)).toThrow(/Из помещения 40 туда прохода нет/)
    expect(snapshot(t.room)).toMatch(/Партия в помещении 40\. Выходы отсюда: .*улица \(§ 29\)/)
  })
})
