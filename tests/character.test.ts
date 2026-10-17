import { describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { changeLives, createHero, gainXp, heroDefense, heroStrength, heroWeapons, rest } from '@/engine/character'
import { addToInventory, buy, equip, sell } from '@/engine/inventory'

describe('персонаж', () => {
  it('создание по правилам: 40 монет, нули, жизни/мана с 0 уровня', () => {
    const w = createHero('Конан', 'warrior', idx)
    expect(w.money).toBe(40); expect(w.level).toBe(0); expect(w.lives).toBe(20); expect(w.mana).toBe(0)
    expect(heroDefense(w, idx)).toBe(9)
    const m = createHero('Мерлин', 'mage', idx)
    expect(m.lives).toBe(10); expect(m.maxMana).toBe(3)
    expect(m.spellbook).toEqual(['mage-magicheskaya-strela'])
    const p = createHero('Жрец', 'priest', idx)
    expect(p.spellbook).toEqual(['priest-lechenie'])
  })
  it('уровни: воин 2000 → 1 уровень, сила +1, жизни 25; мага растёт мана', () => {
    const w = createHero('В', 'warrior', idx)
    w.lives = 18
    const ups = gainXp(w, 2000, idx)
    expect(ups).toHaveLength(1); expect(w.level).toBe(1); expect(w.strength).toBe(1); expect(w.maxLives).toBe(25); expect(w.lives).toBe(23)
    expect(w.pendingSpellPicks).toBe(0)
    const m = createHero('М', 'mage', idx)
    gainXp(m, 1000, idx)
    expect(m.level).toBe(2); expect(m.maxMana).toBe(9); expect(m.pendingSpellPicks).toBe(2)
    const b = createHero('Б', 'barbarian', idx)
    gainXp(b, 60000, idx)
    expect(b.level).toBe(12); expect(b.strength).toBe(2 + 1 + 1); expect(b.maxLives).toBe(85)
  })
  it('жизни: без сознания при 0, смерть при −10, не выше максимума', () => {
    const w = createHero('В', 'warrior', idx)
    changeLives(w, -20); expect(w.lives).toBe(0); expect(w.status.unconscious).toBe(true); expect(w.status.dead).toBeFalsy()
    changeLives(w, 5); expect(w.status.unconscious).toBe(false)
    changeLives(w, -100); expect(w.lives).toBe(-10); expect(w.status.dead).toBe(true)
    const m = createHero('М', 'mage', idx)
    changeLives(m, 50); expect(m.lives).toBe(10)
  })
  it('экипировка: защита доспеха + щит + шлем; двуручное исключает щит; продажа за половину', () => {
    const w = createHero('В', 'warrior', idx)
    w.money = 1000
    const armor = buy(w, 'armor', 'zheleznaya-kolchuga', idx)
    const shield = buy(w, 'armor', 'schit', idx)
    const helm = buy(w, 'armor', 'shlem', idx)
    equip(w, armor.uid, idx); equip(w, shield.uid, idx); equip(w, helm.uid, idx)
    expect(heroDefense(w, idx)).toBe(12 + 1 + 1)
    expect(w.money).toBe(1000 - 50 - 15 - 55)
    const sword = buy(w, 'weapon', 'mech-dvuruchnyy', idx)
    equip(w, sword.uid, idx)
    expect(w.equipment.shield).toBeUndefined()
    expect(heroDefense(w, idx)).toBe(13)
    expect(heroWeapons(w, idx)[0].attacks).toEqual([4, 5, 6, 7, 8, 9])
    const before = w.money
    expect(sell(w, sword.uid, idx)).toBe(100)
    expect(w.money).toBe(before + 100)
    expect(w.equipment.rightHand).toBeUndefined()
  })
  it('ограничения класса: маг не берёт меч, жрец не берёт лук, варвар не берёт меч', () => {
    const m = createHero('М', 'mage', idx); m.money = 500
    const sw = buy(m, 'weapon', 'mech-korotkiy', idx)
    expect(() => equip(m, sw.uid, idx)).toThrow()
    const d = buy(m, 'weapon', 'kinzhal', idx)
    expect(equip(m, d.uid, idx)).toBe('rightHand')
    const p = createHero('Ж', 'priest', idx); p.money = 500
    const bow = buy(p, 'weapon', 'korotkiy-luk', idx)
    expect(() => equip(p, bow.uid, idx)).toThrow()
    const b = createHero('Б', 'barbarian', idx); b.money = 500
    const ax = buy(b, 'weapon', 'boevoy-topor', idx)
    expect(equip(b, ax.uid, idx)).toBe('rightHand')
    const s2 = buy(b, 'weapon', 'mech-dlinnyy', idx)
    expect(() => equip(b, s2.uid, idx)).toThrow()
  })
  it('два одноручных оружия занимают обе руки', () => {
    const t = createHero('Т', 'thief', idx); t.money = 500
    const a = buy(t, 'weapon', 'mech-korotkiy', idx)
    const b = buy(t, 'weapon', 'kinzhal', idx)
    expect(equip(t, a.uid, idx)).toBe('rightHand')
    expect(equip(t, b.uid, idx)).toBe('leftHand')
    expect(heroWeapons(t, idx)).toHaveLength(2)
  })
  it('артефакты: латные рукавицы и перстень прибавляют силу, кольчуга Ундора даёт 16', () => {
    const w = createHero('В', 'warrior', idx)
    const ring = addToInventory(w, 'artifact', '16')
    const mail = addToInventory(w, 'artifact', '12')
    equip(w, ring.uid, idx); equip(w, mail.uid, idx)
    expect(heroStrength(w, idx)).toBe(2)
    expect(heroDefense(w, idx)).toBe(16)
  })
  it('отдых: 2 монеты за сутки, +5 жизней и маны', () => {
    const m = createHero('М', 'mage', idx)
    m.lives = 1; m.mana = 0; m.money = 3
    const r = rest(m, 3, 2, 5, 5)
    expect(r.days).toBe(1); expect(m.money).toBe(1); expect(m.lives).toBe(6); expect(m.mana).toBe(3)
  })
})
