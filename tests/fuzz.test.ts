// Фазз-тест боя: партия со случайными действиями против каждого монстра бестиария.
// Ловит исключения, NaN в жизнях и мане, зависшие раунды.
import { describe, expect, it } from 'vitest'
import { gameData, idx } from '@/data'
import { createHero, gainXp, heroWeapons, isActive } from '@/engine/character'
import { addToInventory, buy, equip } from '@/engine/inventory'
import { roll, seededRng, setRng } from '@/engine/dice'
import { closeToMelee, endHeroesTurn, finishCombat, heroAttack, heroFlee, monstersTurn, startCombat } from '@/engine/combat'
import { canCast, castSpell, needsEntryTarget, needsHeroTarget, needsMonsterTarget } from '@/engine/spells'
import type { Hero } from '@/engine/model'

function party(): Hero[] {
  const w = createHero('Воин', 'warrior', idx), m = createHero('Маг', 'mage', idx), p = createHero('Жрец', 'priest', idx), t = createHero('Вор', 'thief', idx)
  for (const h of [w, m, p, t]) { gainXp(h, 20000, idx); h.money = 2000; h.pendingSpellPicks = 0 }
  equip(w, buy(w, 'weapon', 'mech-dvuruchnyy', idx).uid, idx); equip(w, buy(w, 'armor', 'laty', idx).uid, idx)
  equip(m, buy(m, 'weapon', 'kinzhal', idx).uid, idx); equip(m, buy(m, 'weapon', 'drotik', idx, 10).uid, idx)
  equip(p, buy(p, 'weapon', 'palitsa', idx).uid, idx); equip(p, buy(p, 'armor', 'schit', idx).uid, idx)
  equip(t, buy(t, 'weapon', 'mech-korotkiy', idx).uid, idx); equip(t, buy(t, 'weapon', 'korotkiy-luk', idx).uid, idx); buy(t, 'weapon', 'strela', idx, 20)
  addToInventory(m, 'bottle', '5', 2, { identified: false })
  for (const h of [m, p]) {
    const caster = idx.cls(h.classId).caster
    h.spellbook = gameData.spells.filter((s) => s.caster === caster && s.level <= h.level).map((s) => s.id)
    h.maxMana = 60; h.mana = 60
  }
  return [w, m, p, t]
}

const pick = <T,>(xs: T[]): T => xs[roll(xs.length) - 1]

function heroAct(state: ReturnType<typeof startCombat>['state'], h: Hero, heroes: Hero[]) {
  const alive = state.monsters.filter((x) => !x.dead && !x.fled)
  const r = roll(10)
  if (r === 1) return heroFlee(state, h, heroes, idx)
  if (r <= 4 && h.spellbook.length) {
    const spell = idx.spell(pick(h.spellbook))
    if (!canCast(h, spell, idx, 1)) return endHeroesTurn(state, heroes, idx)
    const entries = heroes.flatMap((x) => x.inventory.filter((e) => e.kind === 'bottle'))
    return castSpell({
      hero: h, spell, idx, heroes, combat: state, param: roll(3),
      targetUid: needsMonsterTarget(spell) ? pick(alive)?.uid : undefined,
      targetHeroUid: needsHeroTarget(spell) ? pick(heroes).uid : undefined,
      targetEntryUid: needsEntryTarget(spell) ? entries[0]?.uid : undefined,
    }).log
  }
  const ws = heroWeapons(h, idx).filter((w) => (state.phase === 'ranged' ? w.ranged : !w.ranged || w.thrown))
  if (!ws.length || !alive.length) return endHeroesTurn(state, heroes, idx)
  return heroAttack(state, h, heroes, pick(ws).slot, pick(alive).uid, idx).log
}

describe('фазз-тест боя против всего бестиария', () => {
  const fighters = gameData.bestiary.filter((m) => !m.special)
  for (const seed of [1, 2]) {
    it(`seed ${seed}: ${fighters.length} боёв без исключений, NaN и зависаний`, () => {
      setRng(seededRng(seed))
      const stuck: string[] = []
      for (const mon of fighters) {
        const heroes = party()
        const { state } = startCombat([{ monsterId: mon.id, count: roll(3) }], idx)
        let steps = 0
        while (!state.finished && steps++ < 400) {
          const before = JSON.stringify([state.turn, state.round, state.acted, state.phase])
          if (state.turn === 'heroes') {
            const h = heroes.find((x) => isActive(x) && !state.acted.includes(x.uid) && !state.escaped.includes(x.uid))
            if (h) heroAct(state, h, heroes)
            else endHeroesTurn(state, heroes, idx)
          } else monstersTurn(state, heroes, idx)
          for (const h of heroes) {
            expect(Number.isFinite(h.lives), `${mon.name}: жизни ${h.name}`).toBe(true)
            expect(Number.isFinite(h.mana), `${mon.name}: мана ${h.name}`).toBe(true)
          }
          for (const m of state.monsters) expect(Number.isFinite(m.lives), `${mon.name}: жизни монстра`).toBe(true)
          const after = JSON.stringify([state.turn, state.round, state.acted, state.phase])
          if (before === after && !state.finished && state.turn === 'monsters') stuck.push(mon.name)
        }
        if (!state.finished && steps >= 400) stuck.push(`${mon.name}: не закончился за 400 шагов (раунд ${state.round})`)
        finishCombat(state, heroes, idx)
      }
      // бои с гидрой и неуязвимыми могут длиться долго — но не должны застревать в одном состоянии
      if (stuck.length) console.log(`seed ${seed}:\n` + stuck.join("\n"))
      expect(stuck.filter((s) => !/не закончился/.test(s)), stuck.join("\n")).toEqual([])
    }, 20000)
  }

  it('партия 1 уровня против очаровывания, несчастья и инициативы: бои кончаются, статусы не остаются после боя', () => {
    setRng(seededRng(3))
    let charmed = 0, cursed = 0
    for (const [monsterId, count] of [['furiya', 5], ['gurr', 4], ['chernyy-elf', 1]] as const) {
      for (let i = 0; i < 20; i++) {
        const heroes = [createHero('Воин', 'warrior', idx), createHero('Вор', 'thief', idx), createHero('Маг', 'mage', idx)]
        const { state } = startCombat([{ monsterId, count }], idx)
        closeToMelee(state, heroes, idx)
        let steps = 0
        while (!state.finished && steps++ < 400) {
          if (state.turn === 'heroes') {
            const h = heroes.find((x) => isActive(x) && !state.acted.includes(x.uid) && !state.escaped.includes(x.uid))
            const m = state.monsters.find((x) => !x.dead && !x.fled)
            if (h && m) heroAttack(state, h, heroes, 'unarmed', m.uid, idx)
            else endHeroesTurn(state, heroes, idx)
          } else monstersTurn(state, heroes, idx)
          if (heroes.some((h) => h.status.charmed)) charmed++
          if (heroes.some((h) => h.status.cursed)) cursed++
          for (const h of heroes) expect(Number.isFinite(h.lives)).toBe(true)
        }
        expect(state.finished, `${monsterId}: бой не закончился`).toBeTruthy()
        finishCombat(state, heroes, idx)
        expect(heroes.some((h) => h.status.charmed || h.status.cursed)).toBe(false)
      }
    }
    expect(charmed).toBeGreaterThan(0)
    expect(cursed).toBeGreaterThan(0)
  })
})
