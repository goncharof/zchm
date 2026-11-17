// «Воплощение» и «Возврат времени» в движке: облик монстра до конца боя, повтор действия уже сходившего героя.
import { beforeEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { createHero, heroDefense, heroWeapons } from '@/engine/character'
import { seededRng, setRng } from '@/engine/dice'
import { heroAttack, startCombat } from '@/engine/combat'
import { castSpell, shapeshiftForms, usableOutOfCombat } from '@/engine/spells'

beforeEach(() => setRng(seededRng(7)))

function mage(level: number, spellId: string) {
  const h = createHero('Маг', 'mage', idx)
  h.level = level
  h.mana = h.maxMana = 60
  h.spellbook.push(spellId)
  return h
}

describe('Воплощение', () => {
  it('маг получает атаки и защиту выбранного монстра до конца боя, жизни прежние', () => {
    const h = mage(10, 'mage-voploschenie')
    const lives = h.lives
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const dragon = idx.monster('krasnyy-drakon')
    const r = castSpell({ hero: h, spell: idx.spell('mage-voploschenie'), idx, heroes: [h], combat: state, monsterId: 'krasnyy-drakon' })
    expect(r.ok).toBe(true)
    expect(h.lives).toBe(lives)
    expect(heroDefense(h, idx)).toBe(dragon.defense)
    const form = heroWeapons(h, idx).find((w) => w.slot === 'spell')!
    expect(form.attacks).toEqual(dragon.attacks)
    expect(form.attacksPerRound).toBe(dragon.attacksPerRound)
    // обликом можно бить в ближнем бою: урон по таблице монстра (или промах)
    state.phase = 'melee'
    state.turn = 'heroes'
    const a = heroAttack(state, h, [h], 'spell', state.monsters[0].uid, idx)
    expect(a.log.some((e) => /к6 = \d → \d|промах/i.test(e.text))).toBe(true)
  })

  it('в персонажа и в создание без обычных атак не воплотиться, мана не тратится', () => {
    const h = mage(10, 'mage-voploschenie')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const odd = idx.data.bestiary.find((m) => !m.special && !Array.isArray(m.attacks))!.id // «смерть», «магия» или «нет»
    for (const id of ['merlin', odd]) {
      const r = castSpell({ hero: h, spell: idx.spell('mage-voploschenie'), idx, heroes: [h], combat: state, monsterId: id })
      expect(r.ok, id).toBe(false)
    }
    expect(castSpell({ hero: h, spell: idx.spell('mage-voploschenie'), idx, heroes: [h], combat: state }).ok).toBe(false)
    expect(h.mana).toBe(60)
    expect(shapeshiftForms(idx).some((m) => m.id === 'merlin' || m.id === odd)).toBe(false)
    expect(shapeshiftForms(idx).some((m) => m.id === 'krasnyy-drakon')).toBe(true)
  })
})

describe('Возврат времени', () => {
  it('герой, который уже сходил, действует заново; не ходившему перекидывать нечего', () => {
    const m = mage(5, 'mage-vozvrat-vremeni')
    const w = createHero('Воин', 'warrior', idx)
    const heroes = [m, w]
    const { state } = startCombat([{ monsterId: 'ork', count: 3 }], idx)
    state.phase = 'melee'
    state.turn = 'heroes'
    const spell = idx.spell('mage-vozvrat-vremeni')
    // воин ещё не ходил — заклинание не срабатывает и маны не берёт
    expect(castSpell({ hero: m, spell, idx, heroes, combat: state, targetHeroUid: w.uid }).ok).toBe(false)
    expect(m.mana).toBe(60)
    heroAttack(state, w, heroes, 'unarmed', state.monsters[0].uid, idx)
    expect(state.acted).toContain(w.uid)
    const r = castSpell({ hero: m, spell, idx, heroes, combat: state, targetHeroUid: w.uid })
    expect(r.ok).toBe(true)
    expect(state.acted).not.toContain(w.uid)
    expect(m.mana).toBe(60 - spell.cost!)
  })

  it('вне боя срабатывает и отдаёт решение ведущему', () => {
    const p = createHero('Жрец', 'priest', idx)
    p.level = 9
    p.mana = p.maxMana = 30
    p.spellbook.push('priest-vozvrat-vremeni')
    const spell = idx.spell('priest-vozvrat-vremeni')
    expect(usableOutOfCombat(spell)).toBe(true)
    const r = castSpell({ hero: p, spell, idx, heroes: [p], combat: null })
    expect(r.ok).toBe(true)
    expect(r.log.some((e) => /решает ведущий/.test(e.text))).toBe(true)
  })
})
