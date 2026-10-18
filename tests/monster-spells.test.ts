// Заклинания монстров: лечение своих, усиления и щиты на себя, контроль и ослабление героев, призыв.
import { afterEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { createHero, gainXp } from '@/engine/character'
import { monsterCast, startCombat, tickHeroStatus as tickCombat } from '@/engine/combat'
import { castSpell } from '@/engine/spells'
import { collectLoot } from '@/engine/loot'
import { seededRng, setRng } from '@/engine/dice'

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

  it('паутина не держит героя выше 3 уровня', () => {
    const { st, m } = caster(['Паутина'], 30)
    const w = createHero('Воин', 'warrior', idx)
    gainXp(w, 30000, idx)
    lowRolls()
    const log = monsterCast(st, m, [w], idx)!
    expect(log.map((e) => e.text).join(' ')).toContain('слишком силён')
    expect(w.status.freeze).toBeUndefined()
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
