import { beforeEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { createHero, gainXp } from '@/engine/character'
import { buy, equip } from '@/engine/inventory'
import { seededRng, setRng } from '@/engine/dice'
import { closeToMelee, heroAttack, heroFlee, monstersTurn, startCombat, finishCombat } from '@/engine/combat'
import { castSpell, resolveCost } from '@/engine/spells'

describe('бой', () => {
  beforeEach(() => setRng(seededRng(2026)))

  it('встреча с орками: бой доходит до конца, опыт = очки × отнятые жизни', () => {
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    equip(w, buy(w, 'weapon', 'mech-dvuruchnyy', idx).uid, idx)
    equip(w, buy(w, 'armor', 'laty', idx).uid, idx)
    const heroes = [w]
    const { state } = startCombat([{ monsterId: 'ork', count: 2 }], idx)
    expect(state.monsters).toHaveLength(2)
    expect(state.phase).toBe('ranged')
    closeToMelee(state)
    expect(state.phase).toBe('melee')
    let guard = 0
    while (!state.finished && guard++ < 200) {
      if (state.turn === 'heroes') {
        const target = state.monsters.find((m) => !m.dead && !m.fled)!
        heroAttack(state, w, heroes, 'rightHand', target.uid, idx)
      } else {
        monstersTurn(state, heroes, idx)
      }
    }
    expect(state.finished).toBeDefined()
    const orc = idx.monster('ork')
    const dealt = state.monsters.reduce((a, m) => a + (m.maxLives - Math.max(0, m.lives)), 0)
    if (state.finished === 'victory') expect(w.xp).toBe(dealt * (orc.points ?? 10))
    finishCombat(state, heroes)
    expect(w.buffs).toEqual([])
  })

  it('на дистанции нельзя бить мечом, но можно стрелять', () => {
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    equip(w, buy(w, 'weapon', 'mech-korotkiy', idx).uid, idx)
    equip(w, buy(w, 'weapon', 'korotkiy-luk', idx).uid, idx)
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const t = state.monsters[0]
    const r1 = heroAttack(state, w, [w], 'rightHand', t.uid, idx)
    expect(r1.hit).toBe(false); expect(state.acted).toHaveLength(0)
    const r2 = heroAttack(state, w, [w], 'ranged', t.uid, idx)
    expect(r2.log.length).toBeGreaterThan(0)
    // единственный герой отстрелялся — противники сошлись вплотную, брошена инициатива
    expect(state.phase).toBe('melee'); expect(state.initiative).toBeDefined()
  })

  it('бегство: при успехе герой покидает бой', () => {
    const w = createHero('Воин', 'warrior', idx)
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    closeToMelee(state)
    let escaped = false
    for (let i = 0; i < 50 && !escaped; i++) {
      heroFlee(state, w, [w])
      escaped = state.escaped.includes(w.uid)
      if (!escaped && !state.finished) { state.turn = 'heroes'; state.acted = [] }
    }
    expect(escaped).toBe(true)
    expect(state.finished).toBe('fled')
  })

  it('магическая стрела: стоимость по числу стрел, урон и опыт', () => {
    const m = createHero('Маг', 'mage', idx)
    gainXp(m, 4000, idx) // 4 уровень, 15 маны
    m.mana = m.maxMana
    const spell = idx.spell('mage-magicheskaya-strela')
    expect(resolveCost(spell, m, 3)).toBe(3)
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const res = castSpell({ hero: m, spell, idx, heroes: [m], combat: state, targetUid: state.monsters[0].uid, param: 3 })
    expect(res.ok).toBe(true)
    expect(res.manaSpent).toBe(3)
    expect(m.mana).toBe(m.maxMana - 3)
    const orc = idx.monster('ork')
    expect(res.xp).toBe(res.damage * (orc.points ?? 10))
  })

  it('лечение жреца: 1 мана = 1 жизнь, 25 опыта за жизнь', () => {
    const p = createHero('Жрец', 'priest', idx)
    const w = createHero('Воин', 'warrior', idx)
    w.lives = 15
    const res = castSpell({ hero: p, spell: idx.spell('priest-lechenie'), idx, heroes: [p, w], targetHeroUid: w.uid, param: 3 })
    expect(res.ok).toBe(true); expect(w.lives).toBe(18); expect(p.mana).toBe(0); expect(res.xp).toBe(75)
  })

  it('призрачный доспех мага даёт защиту по таблице (4 уровень → 14)', () => {
    const m = createHero('Маг', 'mage', idx)
    gainXp(m, 4000, idx); m.mana = m.maxMana
    m.spellbook.push('mage-prizrachnyy-dospeh')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const res = castSpell({ hero: m, spell: idx.spell('mage-prizrachnyy-dospeh'), idx, heroes: [m], combat: state })
    expect(res.ok).toBe(true)
    expect(res.manaSpent).toBe(4)
    expect(m.buffs[0].stat).toBe('defense'); expect(m.buffs[0].amount).toBe(14 - 9)
  })

  it('свет жреца завершает бой бегством', () => {
    const p = createHero('Жрец', 'priest', idx)
    gainXp(p, 4000, idx); p.mana = p.maxMana
    p.spellbook.push('priest-svet')
    const { state } = startCombat([{ monsterId: 'ork', count: 3 }], idx)
    const res = castSpell({ hero: p, spell: idx.spell('priest-svet'), idx, heroes: [p], combat: state })
    expect(res.escaped).toBe(true); expect(state.finished).toBe('fled'); expect(res.xp).toBe(50)
  })
})
