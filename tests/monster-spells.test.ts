// Заклинания монстров: лечение своих, усиления и щиты на себя, контроль и ослабление героев, призыв,
// очаровывание, несчастье и инициатива.
import { afterEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { createHero, gainXp, isActive } from '@/engine/character'
import { cleanupAfterCombat, closeToMelee, heroRoll, monsterAttack, monsterCast, monstersTurn, startCombat, tickHeroStatus as tickCombat } from '@/engine/combat'
import { castSpell } from '@/engine/spells'
import { collectLoot } from '@/engine/loot'
import { seededRng, setRng } from '@/engine/dice'
import { GameSession, blankGame } from '@/game/session'

afterEach(() => setRng(seededRng(1)))
const lowRolls = () => setRng(() => 0) // к6 = 1, к18 = 1, выбор — первый вариант

function fight(monsterId = 'ork', count = 1) {
  const { state } = startCombat([{ monsterId, count }], idx)
  return state
}
function caster(spells: string[], mana = 30) {
  const st = fight('ork', 2)
  const m = st.monsters[0]
  m.spells = spells; m.mana = mana
  return { st, m, other: st.monsters[1] }
}

describe('заклинания монстров', () => {
  it('лечение: раненый союзник получает жизни, мана тратится', () => {
    const { st, m, other } = caster(['Лечение'], 10)
    other.lives = 2
    lowRolls()
    const log = monsterCast(st, m, [createHero('Воин', 'warrior', idx)], idx)!
    expect(log.map((e) => e.text).join(' ')).toContain('восстанавливает')
    expect(other.lives).toBeGreaterThan(2)
    expect(m.mana).toBeLessThan(10)
  })

  it('огненный щит поглощает заклинание героя, отражение возвращает урон заклинателю', () => {
    const st = fight('ork')
    const t = st.monsters[0]
    const mage = createHero('Маг', 'mage', idx)
    gainXp(mage, 4000, idx); mage.mana = mage.maxMana
    t.wards = [{ kind: 'antimagic', level: 6, rounds: 3, source: 'Огненный щит' }]
    const lives = t.lives
    const r = castSpell({ hero: mage, spell: idx.spell('mage-magicheskaya-strela'), idx, heroes: [mage], combat: st, targetUid: t.uid, param: 1 })
    expect(t.lives).toBe(lives)
    expect(r.log.map((e) => e.text).join(' ')).toContain('поглощает')
    t.wards = [{ kind: 'reflect', level: 10, rounds: -1, source: 'Отражение магии' }]
    const before = mage.lives
    castSpell({ hero: mage, spell: idx.spell('mage-magicheskaya-strela'), idx, heroes: [mage], combat: st, targetUid: t.uid, param: 1 })
    expect(mage.lives).toBeLessThan(before)
    expect(t.wards).toEqual([])
  })

  it('удушье: герой задыхается, теряет жизни каждый раунд и ослаблен', () => {
    const { st, m } = caster(['Удушье'], 30)
    m.level = 6
    const w = createHero('Воин', 'warrior', idx)
    lowRolls()
    monsterCast(st, m, [w], idx)
    expect(w.status.choke).toBe(3)
    expect(w.buffs.some((b) => b.stat === 'attacks' && b.multiplier)).toBe(true)
    const lives = w.lives
    setRng(seededRng(3))
    tickCombat(w)
    expect(w.lives).toBeLessThan(lives)
    expect(w.status.choke).toBe(2)
  })

  it('паутина не держит героя выше 3 уровня: на такую партию монстр ману не тратит', () => {
    const { st, m } = caster(['Паутина'], 30)
    const w = createHero('Воин', 'warrior', idx)
    gainXp(w, 30000, idx)
    lowRolls()
    expect(monsterCast(st, m, [w], idx)).toBeNull()
    expect(w.status.freeze).toBeUndefined()
    expect(m.mana).toBe(30)
  })

  it('паутина накрывает всех героев до 3 уровня, а не одного', () => {
    const { st, m } = caster(['Паутина'], 30)
    const a = createHero('Воин', 'warrior', idx)
    const b = createHero('Варвар', 'barbarian', idx)
    const strong = createHero('Маг', 'mage', idx)
    gainXp(strong, 30000, idx)
    lowRolls()
    monsterCast(st, m, [a, b, strong], idx)
    expect(a.status.freeze).toBe(1)
    expect(b.status.freeze).toBe(1)
    expect(strong.status.freeze).toBeUndefined()
  })

  it('очаровывание фурии: герой до 2 уровня не действует, чары спадают на 1 к6 или со смертью фурии', () => {
    const st = fight('furiya')
    const f = st.monsters[0]
    const w = createHero('Воин', 'warrior', idx)
    lowRolls()
    const log = monsterCast(st, f, [w], idx)!
    expect(log.map((e) => e.text).join(' ')).toContain('очарован')
    expect(w.status.charmed).toBe(f.uid)
    expect(isActive(w)).toBe(false)
    // очарованного второй раз не очаровывают: фурия просто бьёт
    expect(monsterCast(st, f, [w], idx)).toBeNull()
    f.hitMod = -100 // фурия промахивается, чтобы чары не снял удар
    setRng(() => 0.99) // к6 = 6: чары держатся
    monstersTurn(st, [w], idx)
    expect(w.status.charmed).toBe(f.uid)
    lowRolls() // к6 = 1: герой стряхивает чары
    const freed = monstersTurn(st, [w], idx).map((e) => e.text).join(' ')
    expect(freed).toContain('стряхивает чары')
    expect(isActive(w)).toBe(true)
    // заклинатель погиб — чары рассеиваются в начале раунда
    const st2 = fight('furiya', 2)
    w.status.charmed = st2.monsters[0].uid
    st2.monsters[0].dead = true
    st2.monsters[1].hitMod = -100
    setRng(() => 0.99)
    expect(monstersTurn(st2, [w], idx).map((e) => e.text).join(' ')).toContain('Чары рассеиваются')
    expect(w.status.charmed).toBeUndefined()
  })

  it('очарованный герой не бежит и не колдует и по сети; чары спадают сразу, как только фурию убили', () => {
    const g = new GameSession(blankGame(), null)
    const mage = g.addHero('Маг', 'mage')
    const warrior = g.addHero('Воин', 'warrior')
    g.startEncounter([{ monsterId: 'furiya', count: 1 }, { monsterId: 'ork', count: 1 }])
    const c = g.state.combat!
    c.phase = 'melee'; c.turn = 'heroes'
    const fury = c.monsters[0]
    mage.status.charmed = fury.uid
    expect(() => g.flee(mage.uid)).toThrow(/не может действовать/)
    expect(() => g.cast(mage.uid, mage.spellbook[0], { targetUid: fury.uid })).toThrow(/не может действовать/)
    // воин добивает фурию — маг тут же приходит в себя и ходит в этом же раунде
    fury.lives = 1
    setRng(() => 0.99)
    g.attack(warrior.uid, 'unarmed', fury.uid)
    expect(fury.dead).toBe(true)
    expect(mage.status.charmed).toBeUndefined()
    expect(c.turn).toBe('heroes')
    expect(g.state.log.some((e) => e.text.includes('Чары рассеиваются'))).toBe(true)
  })

  it('«Удушье» не складывается на герое, и монстр не тратит ману на задыхающегося', () => {
    const { st, m } = caster(['Удушье'], 30)
    m.level = 6
    const w = createHero('Воин', 'warrior', idx)
    lowRolls()
    monsterCast(st, m, [w], idx)
    expect(monsterCast(st, m, [w], idx)).toBeNull()
    // даже если наложить ещё раз (другой монстр с тем же заклинанием) — защита −4 одна
    monsterCast(st, Object.assign(st.monsters[1], { spells: ['Удушье'], mana: 30, level: 6 }), [w, createHero('Вор', 'thief', idx)], idx)
    expect(w.buffs.filter((b) => b.stat === 'defense')).toHaveLength(1)
  })

  it('удар, отнявший жизни, снимает чары с героя', () => {
    const st = fight('furiya')
    const f = st.monsters[0]
    const w = createHero('Воин', 'warrior', idx)
    w.status.charmed = f.uid
    setRng(() => 0.99) // к18 = 18 — попадание
    const log = monsterAttack(f, w, idx).map((e) => e.text).join(' ')
    expect(w.lives).toBeLessThan(w.maxLives)
    expect(log).toContain('чары спадают')
    expect(w.status.charmed).toBeUndefined()
  })

  it('фурия не тратит ману на очаровывание героя выше 2 уровня', () => {
    const st = fight('furiya')
    const w = createHero('Воин', 'warrior', idx)
    gainXp(w, 30000, idx)
    expect(w.level).toBeGreaterThan(2)
    lowRolls()
    expect(monsterCast(st, st.monsters[0], [w], idx)).toBeNull()
    expect(st.monsters[0].mana).toBe(12)
  })

  it('несчастье: до конца боя герой бросает дважды и берёт меньшее', () => {
    const { st, m } = caster(['Несчастье'], 30)
    const w = createHero('Воин', 'warrior', idx)
    lowRolls()
    monsterCast(st, m, [w], idx)
    expect(w.status.cursed).toBe(true)
    const seq = [0.9, 0.1]
    setRng(() => seq.shift() ?? 0.5)
    expect(heroRoll(w)).toBe(2) // 17 и 2 — берётся меньшее
    cleanupAfterCombat([w])
    expect(w.status.cursed).toBeUndefined()
  })

  it('инициатива гурра: монстры бьют первыми; если она есть и у героев — решает бросок', () => {
    const st = fight('gurr')
    const w = createHero('Воин', 'warrior', idx)
    const e = closeToMelee(st, [w], idx)
    expect(e.text).toContain('«Инициатива»')
    expect(st.turn).toBe('monsters')
    expect(st.monsters[0].mana).toBe(7)
    const st2 = fight('gurr')
    w.status.initiative = true
    setRng(seededRng(5))
    expect(closeToMelee(st2, [w], idx).text).toContain('решает бросок')
    expect(w.status.initiative).toBeUndefined()
  })

  it('усиления на себя: огненный меч и молитва; повторно не накладываются', () => {
    const { st, m } = caster(['Огненный меч'], 30)
    lowRolls()
    monsterCast(st, m, [createHero('Воин', 'warrior', idx)], idx)
    expect(m.attackMod).toBe(4)
    expect(m.hitMod).toBe(2)
    m.spells = ['Огненный меч', 'Паралич']
    monsterCast(st, m, [createHero('Воин', 'warrior', idx)], idx)
    expect(m.attackMod).toBe(4) // меч уже в руках — выбрана атака
  })

  it('призванный элементал вступает в бой и не оставляет трофеев', () => {
    const { st, m } = caster(['Создание элементалов'], 30)
    lowRolls()
    monsterCast(st, m, [createHero('Воин', 'warrior', idx)], idx)
    const el = st.monsters.find((x) => x.summoned)!
    expect(el.name).toBe('Воздушный элементал')
    el.dead = true
    expect(collectLoot([el])).toEqual([])
  })
})
