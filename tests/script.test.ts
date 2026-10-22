// Сценарный ведущий без ИИ: сцены, кнопки-варианты, действия движком.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { seededRng, setRng } from '@/engine/dice'
import { createGameServer, type GameServer } from '../server/app'
import { bottleSales, luckPenalty } from '../server/gm/script'
import { checkEnd } from '@/engine/combat'

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

async function setup() {
  setRng(seededRng(5))
  const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap })
  servers.push(s)
  const c = new NetClient(s.url)
  clients.push(c)
  let state: GameState | null = null
  const chat: ChatMessage[] = []
  c.onState((x) => { state = x })
  c.onChat((m) => chat.push(m))
  c.onChatUpdate((m) => { const i = chat.findIndex((x) => x.id === m.id); if (i >= 0) chat[i] = m })
  const j = await c.create('Иван', 'script')
  await c.call('quickStart', [])
  return { s, c, j, chat, get state() { return state! } }
}
const lastGm = (chat: ChatMessage[]) => [...chat].reverse().find((m) => m.from === 'gm')!
/** выиграть начатый бой и закончить его: ведущий открывает исходы победы по книге */
async function winFight(g: { s: GameServer; j: { code: string }; c: NetClient; chat: ChatMessage[]; state: GameState }) {
  await until(() => !!g.state.combat)
  const room = (await g.s.store.get(g.j.code))!
  for (const m of room.state.combat!.monsters) m.dead = true
  checkEnd(room.state.combat!, room.state.heroes)
  await g.c.call('endCombat', [])
  await until(() => lastGm(g.chat).text.includes('Бой окончен'))
  return lastGm(g.chat)
}
/** партия на нужном узле карты (войти можно только туда, где она стоит) */
async function goTo(g: { s: GameServer; j: { code: string } }, nodeId: string) { (await g.s.store.get(g.j.code))!.state.worldNodeId = nodeId }

describe('сценарный ведущий', () => {
  it('вход в локацию, номер помещения → этапы по книге: бой, после победы дверь (удача или отмычки), за дверью выбор', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('Идём в помещение 1', true)
    await until(() => g.chat.some((m) => m.from === 'gm' && /помещение 1/.test(m.text)))
    const scene = lastGm(g.chat)
    expect(scene.text).toContain('зомби')
    // дверь, камера и награда — после боя, проверки и выбора
    expect(scene.text).not.toContain('открыть дверь')
    expect(scene.text).not.toContain('камера')
    expect(scene.choices!.map((c) => c.label)).toEqual(['⚔ Бой: Зомби', 'Идти дальше'])
    expect(g.state.visited['zolotoy-gorod']).toContain(1)

    await g.c.choose(scene.id, scene.choices![0].id)
    const door = await winFight(g)
    expect(door.text).toContain('открыть дверь можно только магическими отмычками или удача — 12')
    expect(door.choices!.map((c) => c.label)).toContain('🎲 Проверка удачи 12')
    expect(door.choices!.some((c) => c.label.startsWith('🗝'))).toBe(false)

    // с магическими отмычками дверь открывается без проверки
    const room = (await g.s.store.get(g.j.code))!
    room.session().giveItem(room.state.heroes[0].uid, 'item', 'magicheskie-otmychki')
    await g.c.chat('1', true)
    await until(() => /вы здесь уже были/.test(lastGm(g.chat).text))
    const again = lastGm(g.chat)
    expect(again.choices!.some((c) => c.label.startsWith('⚔'))).toBe(false)
    await g.c.choose(again.id, again.choices!.find((c) => c.label === '🗝 Открыть: магические отмычки')!.id)
    await until(() => /тесная камера/.test(lastGm(g.chat).text))
    const cell = lastGm(g.chat)
    expect(cell.text).not.toContain('дарит')
    await g.c.choose(cell.id, cell.choices!.find((c) => c.label === '▸ Если вы его освобождаете')!.id)
    // номер бутылки игрокам не показывается: «(6)» — пометка ведущего
    await until(() => /дарит вам \(бутылка\)/.test(lastGm(g.chat).text))
    const outcome = lastGm(g.chat)
    expect(outcome.text).not.toContain('(6)')
    expect(outcome.choices!.map((c) => c.label)).toEqual(expect.arrayContaining(['Взять бутылку', 'Взять свиток 5 ур.']))
  })

  it('покупка у торговца в пути: без 200 монет вариант остаётся, с деньгами — плата и артефакт', async () => {
    const g = await setup()
    const room = (await g.s.store.get(g.j.code))!
    room.state.pendingRoad = [106]
    await g.c.chat('§ 106', true)
    await until(() => /В пути \(§ 106\)/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    const buy = scene.choices!.find((c) => c.label === '▸ Купить артефакт за 200 монет')!
    const hero = room.state.heroes[0]
    hero.money = 10
    await g.c.choose(scene.id, buy.id)
    await until(() => /не хватает монет/.test(lastGm(g.chat).text))
    expect(room.state.claimed ?? []).not.toContain('doroga:106:b:open')
    hero.money = 250
    await g.c.choose(scene.id, buy.id)
    await until(() => /По книге: −200 монет/.test(lastGm(g.chat).text))
    expect(hero.money).toBe(50)
    expect(lastGm(g.chat).choices!.map((c) => c.label)).toContain('Взять артефакт')
  })

  it('переход в другое помещение: грифон уносит в центр города, спасённый дварф становится спутником', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await g.c.chat('35', true)
    await until(() => /помещение 35/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label === '▸ Если вы последовали этому совету')!.id)
    await until(() => /помещение 41/.test(lastGm(g.chat).text))
    const square = lastGm(g.chat)
    expect(g.state.visited['zolotoy-gorod']).toContain(41)
    await g.c.choose(square.id, square.choices!.find((c) => c.label === '▸ Если помогаете ему')!.id)
    await until(() => lastGm(g.chat).choices?.some((c) => c.label === '⚔ Бой: Стражник ×4') ?? false)
    const fight = lastGm(g.chat)
    await g.c.choose(fight.id, fight.choices!.find((c) => c.label === '⚔ Бой: Стражник ×4')!.id)
    const after = await winFight(g)
    expect(after.text).toContain('идет с вами')
    await until(() => g.state.companions.some((c) => c.monsterId === 'dvarf'))
  })

  it('свободная реплика без номера — подсказка; плата без денег не проходит и вариант снова доступен', async () => {
    const g = await setup()
    await g.c.chat('Поговорим с трактирщиком', true)
    await until(() => lastGm(g.chat)?.text.includes('понимает номера'))
    await goTo(g, 'gorod-zhretsov')
    await g.c.call('enterLocation', ['zamok-zhretsov'])
    await g.c.chat('17', true)
    await until(() => /помещение 17/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    const pay = scene.choices!.find((c) => c.label === '▸ Отдать 10 монет')!
    // жрец быстрого старта потратил все 40 монет на палицу: платить нечем
    const priest = g.state.heroes.find((h) => h.classId === 'priest')!
    expect(priest.money).toBe(0)
    await g.c.claimHero(priest.uid)
    await g.c.choose(scene.id, pay.id)
    await until(() => /не хватает монет/i.test(lastGm(g.chat).text))
    expect(g.chat.find((m) => m.id === scene.id)!.used ?? []).not.toContain(pay.id)
  })

  it('заклинание, которое движок не отыгрывает, доходит до ведущего: «Чтение силы» в бою показывает противников', async () => {
    const g = await setup()
    const room = (await g.s.store.get(g.j.code))!
    const priest = room.state.heroes.find((h) => h.classId === 'priest')!
    priest.mana = priest.maxMana = 20
    priest.spellbook.push('priest-chuvstvo-zla', 'priest-chtenie-sily')
    await g.c.claimHero(priest.uid)
    await g.c.call('cast', [priest.uid, 'priest-chuvstvo-zla', {}])
    await until(() => /«Чувство зла»: сценарный ведущий/.test(lastGm(g.chat)?.text ?? ''))
    room.session().startEncounter([{ monsterId: 'ork', count: 2 }]) // бой начинает ведущий
    await g.c.call('cast', [priest.uid, 'priest-chtenie-sily', {}])
    await until(() => /читает силу/.test(lastGm(g.chat)?.text ?? ''))
    const text = lastGm(g.chat).text
    expect(text.match(/Орк( \d)?: уровень/g)?.length).toBe(2)
    expect(text).toContain('защита')
    // заклинание с механикой ведущему не пересказывается
    const mage = room.state.heroes.find((h) => h.classId === 'mage')!
    await g.c.claimHero(mage.uid)
    const before = g.chat.length
    await g.c.call('cast', [mage.uid, mage.spellbook[0], { targetUid: room.state.combat!.monsters[0].uid }])
    await wait(100)
    expect(g.chat.slice(before).some((m) => m.from === 'gm')).toBe(false)
  })

  it('слитые разметкой исходы разрезаны: провал «Перерубить — удача 8» ведёт в свою ветку с 217 монетами', async () => {
    const g = await setup()
    const room = (await g.s.store.get(g.j.code))!
    await g.c.claimHero(room.state.heroes[0].uid)
    await goTo(g, 'upokoische')
    await g.c.call('enterLocation', ['upokoische'])
    await g.c.chat('26', true)
    await until(() => /помещение 26/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    setRng(() => 0) // к18 = 1 — провал
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label.includes('удачи 8'))!.id)
    await until(() => lastGm(g.chat).text.includes('испытывает удачу'))
    // исход провала открывается сам, исход удачи остаётся скрытым
    const res = lastGm(g.chat)
    expect(res.text).toMatch(/Не перерубаете — .*Падаете без чувств/)
    expect(res.text).not.toContain('Если перерубаете')
    const labels = res.choices!.map((c) => c.label)
    expect(labels).toContain('Забрать 217 монет')
    expect(labels).not.toContain('Забрать 176 монет')
  })

  it('проверка удачи внутри ветки: провал «пробить — удача 9» открывает ветку «Не пробиваете»', async () => {
    const g = await setup()
    const room = (await g.s.store.get(g.j.code))!
    await g.c.claimHero(room.state.heroes[0].uid)
    await goTo(g, 'zamok-korolya-nazgulov')
    await g.c.call('enterLocation', ['krepost-korolya-nazgulov'])
    await g.c.chat('24', true)
    await until(() => /помещение 24/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label === '▸ Бьете его (пробить — удача 9)')!.id)
    await until(() => /Раздается вопль/.test(lastGm(g.chat).text))
    const branch = lastGm(g.chat)
    setRng(() => 0) // к18 = 1 — провал
    await g.c.choose(branch.id, branch.choices!.find((c) => c.label.includes('удачи 9'))!.id)
    await until(() => lastGm(g.chat).text.includes('испытывает удачу'))
    expect(lastGm(g.chat).text).toContain('Не пробиваете —')
  })

  it('после победы исход открывается сам: минотавр требует половину — отдать или биться с ним', async () => {
    const g = await setup()
    await goTo(g, 'mertvyy-gorod')
    await g.c.call('enterLocation', ['mertvyy-gorod'])
    await g.c.chat('31', true)
    await until(() => /помещение 31/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    expect(scene.text).not.toContain('192')
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label.startsWith('⚔ Бой:'))!.id)
    const after = await winFight(g)
    expect(after.text).toMatch(/Если убиваете дракона — минотавр требует половину/)
    expect(after.text).not.toContain('192')
    const labels = after.choices!.map((c) => c.label)
    expect(labels).toEqual(expect.arrayContaining(['▸ Отдаете половину', '▸ Не отдаете']))
    await g.c.choose(after.id, after.choices!.find((c) => c.label === '▸ Не отдаете')!.id)
    await until(() => lastGm(g.chat).choices?.some((c) => c.label === '⚔ Бой: Минотавр') ?? false)
  })

  it('выбор открывает бой, победа — награду; второй бой с теми же монстрами не предлагается', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await g.c.chat('24', true)
    await until(() => /помещение 24/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    // что стражник — драконид, видно только после предупреждения
    expect(scene.choices!.some((c) => c.label.startsWith('⚔'))).toBe(false)
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label === '▸ Если предупреждаете короля')!.id)
    await until(() => /это драконид/.test(lastGm(g.chat).text))
    const warn = lastGm(g.chat)
    await g.c.choose(warn.id, warn.choices!.find((c) => c.label === '⚔ Бой: Драконид')!.id)
    const after = await winFight(g)
    expect(after.text).toMatch(/Короля Золотого города/i)
    const labels = after.choices!.map((c) => c.label)
    expect(labels.some((l) => l.startsWith('⚔'))).toBe(false)
    expect(labels).toEqual(expect.arrayContaining(['Взять бутылку', 'Взять: меч двуручный']))
    // выбор был один из двух: «ничего не предпринимаете» после него не предлагается
    expect(labels).not.toContain('▸ Если вы ничего не предпринимаете')
  })

  it('исходы боя и проверки удачи не видны до боя и броска: их текст и награды не взять заранее', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await g.c.chat('2', true)
    await until(() => /помещение 2\b/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    const labels = scene.choices!.map((c) => c.label)
    expect(labels).toContain('▸ Если вы решили помочь стражникам, бросьте кубик')
    expect(labels).not.toContain('▸ Если вы выходите из схватки победителем')
    expect(labels).not.toContain('▸ Если лестница не откинута')
    expect(scene.text).not.toContain('по бутылке (5)')
  })

  it('повторный вход после победы: бой не предлагается снова, исход победы виден', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await g.c.chat('38', true)
    await until(() => /помещение 38/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    expect(scene.text).not.toContain('65 монет')
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label === '⚔ Бой: Железный человек')!.id)
    const after = await winFight(g)
    expect(after.choices!.map((c) => c.label)).toContain('Забрать 65 монет')
    await g.c.chat('38', true)
    await until(() => /вы здесь уже были/.test(lastGm(g.chat).text))
    const again = lastGm(g.chat)
    expect(again.text).toContain('в сундуке 65 монет')
    expect(again.choices!.some((c) => c.label.startsWith('⚔'))).toBe(false)
  })

  it('бросок по списку открывает свой исход и второй раз не предлагается', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await g.c.chat('2', true)
    await until(() => /помещение 2\b/.test(lastGm(g.chat)?.text ?? ''))
    // список исходов не виден до броска
    expect(lastGm(g.chat).text).not.toContain('приставляют')
    const scene = lastGm(g.chat)
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label.startsWith('▸ Если вы решили помочь'))!.id)
    await until(() => lastGm(g.chat).choices?.some((c) => c.label === '🎲 Бросить к6 по списку') ?? false)
    const branch = lastGm(g.chat)
    setRng(() => 0.4) // к6 = 3
    await g.c.choose(branch.id, branch.choices!.find((c) => c.label === '🎲 Бросить к6 по списку')!.id)
    await until(() => /^Выпало 3 — /.test(lastGm(g.chat).text))
    expect(lastGm(g.chat).text).toContain('приставляют 1 лестницу')
    // откинуть лестницу — удача 10; не вышло — бой со взобравшимися драконидами
    const ladder = lastGm(g.chat)
    setRng(() => 0) // к18 = 1 — провал
    await g.c.choose(ladder.id, ladder.choices!.find((c) => c.label === '🎲 Проверка удачи 10')!.id)
    await until(() => lastGm(g.chat).text.includes('испытывает удачу'))
    expect(lastGm(g.chat).choices!.map((c) => c.label)).toContain('⚔ Бой: Драконид ×4')
    await g.c.chat('2', true)
    await until(() => /вы здесь уже были/.test(lastGm(g.chat).text))
    expect(lastGm(g.chat).choices!.some((c) => c.label.startsWith('🎲 Бросить'))).toBe(false)
  })

  it('одинаковые бутылки в сцене берутся одной кнопкой', async () => {
    const g = await setup()
    const room = (await g.s.store.get(g.j.code))!
    const hero = room.state.heroes[0]
    await g.c.claimHero(hero.uid)
    await goTo(g, 'runnoe-more')
    await g.c.call('enterLocation', ['runnoe-more'])
    await g.c.chat('11', true)
    await until(() => /помещение 11/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    const take = scene.choices!.find((c) => c.label === 'Взять 5 бутылок')!
    expect(take).toBeDefined()
    // номер бутылки — пометка ведущего: ни на кнопке, ни в тексте сцены его нет
    expect(scene.choices!.filter((c) => /\(\d\)/.test(c.label))).toHaveLength(0)
    expect(scene.text).not.toMatch(/\([1-6]\)/)
    await g.c.choose(scene.id, take.id)
    await until(() => /забирает 5 бутылок без этикеток/.test(lastGm(g.chat).text))
    expect(room.state.heroes[0].inventory.filter((e) => e.kind === 'bottle' && e.ref === '4').reduce((n, e) => n + e.qty, 0)).toBe(5)
  })

  it('продажа бутылок распознаётся по тексту, подарок и плата за совет — нет', () => {
    expect(bottleSales('Трактирщик предлагает бутылку (5) за 15 монет. У него целых 4 таких бутылки.', { prices: [15], bottles: [5] })).toEqual([{ bottles: [5], price: 15, stock: 4 }])
    expect(bottleSales('Предлагает 2 бутылки за 20 монет: (3), (3).', { prices: [20], bottles: [3, 3] })).toEqual([{ bottles: [3, 3], price: 20, stock: 1 }])
    expect(bottleSales('Предлагает две бутылки (5), (5). За каждую просит 10 монет.', { prices: [10], bottles: [5, 5] })).toEqual([{ bottles: [5], price: 10, stock: 2 }])
    expect(bottleSales('продает бутылки (4) за 5 монет (у него 4 бутылки) и (5) за 10 монет (у него 2 бутылки)', { prices: [5, 10], bottles: [4, 5] })).toEqual([{ bottles: [4], price: 5, stock: 4 }, { bottles: [5], price: 10, stock: 2 }])
    expect(bottleSales('На столе ряд бутылок. Торговец предлагает купить 2 бутылки по 5 монет каждую.', { prices: [5], bottles: [2, 6, 2] })).toEqual([{ bottles: [2], price: 5, stock: 2 }, { bottles: [6], price: 5, stock: 1 }])
    expect(bottleSales('Дарит вам (3) и убегает. Падает на колени и просит 5 монет.', { prices: [5], bottles: [3] })).toEqual([])
    expect(bottleSales('Стражник говорит, что за 10 монет даст вам совет. А — 300 монет и (6).', { prices: [10], bottles: [6] })).toEqual([])
  })

  it('в таверне бутылку покупают одной кнопкой: монеты списываются, бутылка выдаётся', async () => {
    const g = await setup()
    const room = (await g.s.store.get(g.j.code))!
    const hero = room.state.heroes[0]
    hero.money = 40
    await g.c.claimHero(hero.uid)
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await g.c.chat('14', true)
    await until(() => /помещение 14/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    const labels = scene.choices!.map((c) => c.label)
    expect(labels).toContain('Купить бутылку за 15 монет (в запасе 4)')
    expect(labels.some((l) => l.startsWith('Взять бутылку') || l.startsWith('Заплатить'))).toBe(false)
    const bottles = () => room.state.heroes[0].inventory.filter((e) => e.kind === 'bottle' && e.ref === '5').reduce((n, e) => n + e.qty, 0)
    const before = bottles()
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label.startsWith('Купить'))!.id)
    await until(() => /платит 15 монет и получает бутылку/.test(lastGm(g.chat).text))
    expect(room.state.heroes[0].money).toBe(25)
    expect(bottles()).toBe(before + 1)
    // запас трактирщика убывает: при повторном входе бутылок осталось три
    await g.c.chat('14', true)
    await until(() => g.chat.filter((m) => m.from === 'gm' && /помещение 14/.test(m.text)).length === 2)
    expect(lastGm(g.chat).choices!.map((c) => c.label)).toContain('Купить бутылку за 15 монет (в запасе 3)')
  })

  it('последствие провала берётся из текста книги', () => {
    expect(luckPenalty('пускает молнию (удача — 6, иначе смерть)', 6)).toMatchObject({ kind: 'death' })
    expect(luckPenalty('2 берсеркера. Удача — 14, иначе — -2 жизни', 14)).toMatchObject({ kind: 'lives', amount: 2, text: '−2 жизни' })
    expect(luckPenalty('Впереди водопад. Удача — 12, иначе — 1 жизнь', 12)).toMatchObject({ kind: 'lives', amount: 1, text: '−1 жизнь' })
    expect(luckPenalty('Удача — 12, иначе половина жизней исчезает', 12)).toMatchObject({ kind: 'half' })
    expect(luckPenalty('вас охватывает паралич (удача — 13, жизни не отнимаются)', 13)).toBeNull()
    expect(luckPenalty('Удача — 14, иначе — -2 жизни', 4)).toBeNull()
    expect(luckPenalty('Отрубить ее — удача — 4. Иначе — верная смерть.', 4)).toMatchObject({ kind: 'death' })
    expect(luckPenalty('Чтобы выйти из гроба — удача — 6. Иначе — смерть.', 6)).toMatchObject({ kind: 'death' })
    expect(luckPenalty('Удача — 6. Потом идите дальше. Иначе — смерть.', 6)).toBeNull()
  })

  it('провал проверки удачи: кнопка последствия из текста отнимает жизни у проверявшего героя', async () => {
    const g = await setup()
    await goTo(g, 'krepost-posledney-nadezhdy')
    await g.c.call('enterLocation', ['krepost-posledney-nadezhdy'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('29', true)
    await until(() => lastGm(g.chat).text.includes('помещение 29'))
    const scene = lastGm(g.chat)
    setRng(() => 0) // к18 = 1 — провал
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label.includes('удачи 14'))!.id)
    await until(() => lastGm(g.chat).text.includes('испытывает удачу'))
    const res = lastGm(g.chat)
    expect(res.text).toContain('По книге: иначе — −2 жизни')
    const hero = g.state.heroes.find((h) => res.text.startsWith(h.name))!
    const before = hero.lives
    await g.c.choose(res.id, res.choices!.find((c) => c.label === 'Принять последствия: −2 жизни')!.id)
    await until(() => g.state.heroes.find((h) => h.uid === hero.uid)!.lives === before - 2)
  })

  it('после боя исход победы из параграфа открывается сам', async () => {
    const g = await setup()
    await goTo(g, 'krepost-posledney-nadezhdy')
    await g.c.call('enterLocation', ['krepost-posledney-nadezhdy'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('40', true)
    await until(() => lastGm(g.chat).text.includes('помещение 40'))
    const scene = lastGm(g.chat)
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label === '▸ Соглашаетесь')!.id)
    await until(() => lastGm(g.chat).text.includes('Сражаетесь с рыцарем'))
    const branch = lastGm(g.chat)
    await g.c.choose(branch.id, branch.choices!.find((c) => c.label.startsWith('⚔ Бой: Рыцарь'))!.id)
    await until(() => !!g.state.combat)
    const room = (await g.s.store.get(g.j.code))!
    for (const m of room.state.combat!.monsters) m.dead = true
    checkEnd(room.state.combat!, room.state.heroes)
    await g.c.call('endCombat', [])
    await until(() => lastGm(g.chat).text.includes('Бой окончен'))
    // исход победы открывается сам — без кнопки «▸ Побеждаете»
    expect(lastGm(g.chat).text).toContain('Побеждаете —')
    expect(lastGm(g.chat).choices!.map((c) => c.label)).not.toContain('▸ Побеждаете')
  })

  it('награду из помещения можно забрать один раз, даже если войти в него снова', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('Помещение 22', true)
    await until(() => lastGm(g.chat).text.includes('помещение 22'))
    const first = lastGm(g.chat)
    const take = first.choices!.find((c) => c.label === 'Забрать 20 монет')!
    const money = () => g.state.heroes.reduce((a, h) => a + h.money, 0)
    const before = money()
    await g.c.choose(first.id, take.id)
    await until(() => money() === before + 20)
    await g.c.chat('Помещение 22', true)
    await until(() => lastGm(g.chat).text.includes('вы здесь уже были'))
    expect(lastGm(g.chat).choices!.some((c) => c.label === 'Забрать 20 монет')).toBe(false)
  })

})
