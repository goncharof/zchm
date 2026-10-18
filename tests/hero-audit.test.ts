// Регрессии по аудиту героев: распознаватель напитков, украшения, двуручное оружие, уровни, отдых, запись заклинаний.
import { afterEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { createHero, gainXp, heroDefense, heroLuck } from '@/engine/character'
import { addToInventory, buy, equip, entryName, poisonWeapon } from '@/engine/inventory'
import { heroAttack, startCombat } from '@/engine/combat'
import { seededRng, setRng } from '@/engine/dice'
import { GameSession, blankGame, migrate } from '@/game/session'

afterEach(() => setRng(seededRng(1)))

describe('аудит героев', () => {
  it('распознаватель говорит только «опасна или нет», ответ пишется на бутылку, второй раз не проверить', () => {
    const s = new GameSession(blankGame(), null)
    const h = s.addHero('Вор', 'thief')
    s.giveItem(h.uid, 'item', 'raspoznavatel-napitkov')
    s.giveItem(h.uid, 'bottle', '1', 1, false)
    const bottle = h.inventory.find((e) => e.kind === 'bottle')!
    setRng(() => 0.99) // к6 = 6 — не ошибается
    s.identifyBottle(h.uid, bottle.uid)
    expect(bottle.verdict).toBe('danger')
    expect(bottle.identified).toBeFalsy()
    expect(entryName(bottle, idx)).toBe('Бутылка без этикетки (распознаватель: опасна)')
    expect(() => s.identifyBottle(h.uid, bottle.uid)).toThrow(/уже проверяли/)
    // вторая бутылка с тем же номером не ложится в ту же стопку
    s.giveItem(h.uid, 'bottle', '1', 1, false)
    expect(h.inventory.filter((e) => e.kind === 'bottle')).toHaveLength(2)
  })

  it('все четыре украшения-артефакта носятся сразу, бонусы складываются', () => {
    const h = createHero('Вор', 'thief', idx)
    const base = heroDefense(h, idx)
    for (const n of [15, 16, 17, 18]) equip(h, addToInventory(h, 'artifact', String(n)).uid, idx)
    expect(Object.keys(h.equipment).sort()).toEqual(['amulet', 'bracelet', 'necklace', 'ring'])
    expect(heroDefense(h, idx)).toBe(base + 2)
    expect(heroLuck(h, idx)).toBe(4)
  })

  it('старое сохранение со слотами «украшение 1/2» переносится в свои слоты', () => {
    const g = blankGame()
    const h = createHero('Вор', 'thief', idx)
    const amulet = addToInventory(h, 'artifact', '17')
    ;(h.equipment as Record<string, string>).accessory1 = amulet.uid
    g.heroes.push(h)
    migrate(g)
    expect(h.equipment).toEqual({ amulet: amulet.uid })
  })

  it('с двуручным оружием вторую руку не занять; щит уступает левую руку', () => {
    const w = createHero('Воин', 'warrior', idx)
    w.money = 500
    equip(w, buy(w, 'weapon', 'mech-dvuruchnyy', idx).uid, idx)
    const dagger = buy(w, 'weapon', 'kinzhal', idx)
    expect(() => equip(w, dagger.uid, idx, 'leftHand')).toThrow(/двуручным/)
    // без выбора руки кинжал заменяет двуручный меч в правой
    equip(w, dagger.uid, idx)
    expect(w.equipment.leftHand).toBeUndefined()
    expect(w.equipment.rightHand).toBe(dagger.uid)
    // меч + щит + кинжал «в левую»: щит снимается
    const sword = buy(w, 'weapon', 'mech-korotkiy', idx)
    equip(w, sword.uid, idx, 'rightHand')
    equip(w, buy(w, 'armor', 'schit', idx).uid, idx)
    equip(w, dagger.uid, idx, 'leftHand')
    expect(w.equipment.shield).toBeUndefined()
    expect(w.equipment.leftHand).toBe(dagger.uid)
  })

  it('переход на уровень возвращает в сознание, если жизни стали положительными; мёртвого не оживляет', () => {
    const m = createHero('Маг', 'mage', idx)
    m.lives = -2; m.status.unconscious = true
    gainXp(m, 600, idx)
    expect(m.level).toBeGreaterThan(0)
    expect(m.lives).toBeGreaterThan(0)
    expect(m.status.unconscious).toBe(false)
    const dead = createHero('Вор', 'thief', idx)
    dead.lives = -10; dead.status.dead = true; dead.status.unconscious = true
    gainXp(dead, 1200, idx)
    expect(dead.lives).toBe(-10)
  })

  it('отдых прибавляет жизни к настоящим, мёртвый не отдыхает и не платит', () => {
    const s = new GameSession(blankGame(), null)
    const a = s.addHero('Воин', 'warrior')
    const d = s.addHero('Вор', 'thief')
    a.lives = -8; a.status.unconscious = true
    d.lives = -10; d.status.dead = true
    s.restAll(1)
    expect(a.lives).toBe(-3)
    expect(a.status.unconscious).toBe(true)
    expect(d.money).toBe(40)
  })

  it('свиток можно прочесть один раз: заклинания нет в книге, маны не нужно, свиток разрушается', () => {
    const s = new GameSession(blankGame(), null)
    const p = s.addHero('Жрец', 'priest')
    const m = s.addHero('Маг', 'mage')
    s.giveItem(p.uid, 'scroll', 'priest-molitva', 1, true)
    const scroll = p.inventory.find((e) => e.kind === 'scroll')!
    const mana = p.mana
    // маг свиток жреца не прочтёт, да и чужой свиток — не его
    expect(() => s.cast(m.uid, 'priest-molitva', { scrollUid: scroll.uid })).toThrow(/свитка у героя нет/)
    const r = s.cast(p.uid, 'priest-molitva', { scrollUid: scroll.uid, targetHeroUid: p.uid })
    expect(r.ok).toBe(true)
    expect(p.mana).toBe(mana)
    expect(p.buffs.some((b) => b.ward === 'prayer')).toBe(true)
    expect(p.inventory.some((e) => e.kind === 'scroll')).toBe(false)
    expect(s.state.log.some((e) => e.text.includes('Свиток рассыпается'))).toBe(true)
  })

  it('порцией яда смазывают 10 стрел, у каждой свой яд; лук не смазывают; клинок отравлен до первого попадания', () => {
    const t = createHero('Вор', 'thief', idx)
    t.money = 1000
    equip(t, buy(t, 'weapon', 'korotkiy-luk', idx).uid, idx)
    const arrows = buy(t, 'weapon', 'strela', idx, 20)
    buy(t, 'item', 'yad', idx, 2)
    const bow = t.inventory.find((e) => e.ref === 'korotkiy-luk')!
    expect(() => poisonWeapon(t, bow.uid, idx)).toThrow(/стрелы, а не лук/)
    poisonWeapon(t, arrows.uid, idx)
    const stacks = t.inventory.filter((e) => e.ref === 'strela')
    expect(stacks.map((e) => [e.qty, !!e.poisoned]).sort()).toEqual([[10, false], [10, true]])
    const { state } = startCombat([{ monsterId: 'troll', count: 1 }], idx)
    const troll = state.monsters[0]
    troll.lives = troll.maxLives = 500
    setRng(() => 0.99)
    heroAttack(state, t, [t], 'ranged', troll.uid, idx)
    expect(troll.poison).toBeGreaterThan(0)
    const left = t.inventory.find((e) => e.ref === 'strela' && e.poisoned)!
    expect(left.qty).toBe(9)
    // меч: яд до первого попадания
    const w = createHero('Воин', 'warrior', idx)
    w.money = 1000
    const sword = buy(w, 'weapon', 'mech-korotkiy', idx)
    equip(w, sword.uid, idx)
    buy(w, 'item', 'yad', idx)
    poisonWeapon(w, sword.uid, idx)
    const melee = startCombat([{ monsterId: 'troll', count: 1 }], idx).state
    melee.phase = 'melee'; melee.turn = 'heroes'
    melee.monsters[0].lives = melee.monsters[0].maxLives = 500
    heroAttack(melee, w, [w], 'rightHand', melee.monsters[0].uid, idx)
    expect(melee.monsters[0].poison).toBeGreaterThan(0)
    expect(sword.poisoned).toBe(false)
  })

  it('в книгу записывается только заклинание своего класса', () => {
    const s = new GameSession(blankGame(), null)
    const m = s.addHero('Маг', 'mage')
    m.pendingSpellPicks = 1
    const priestSpell = idx.data.spells.find((x) => x.caster === 'priest' && x.level === 0)!
    expect(() => s.learnSpell(m.uid, priestSpell.id)).toThrow(/другого класса/)
  })
})
