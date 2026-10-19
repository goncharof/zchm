// Регрессии по аудиту заклинаний героев: время действия вне боя, повторное наложение, цели, щиты монстров, опыт.
import { afterEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { createHero, gainXp, heroDefense } from '@/engine/character'
import { alliesTurn, makeAlly, monsterAttack, monstersTurn, startCombat } from '@/engine/combat'
import { canCast, castSpell } from '@/engine/spells'
import { seededRng, setRng } from '@/engine/dice'
import type { Hero } from '@/engine/model'

afterEach(() => setRng(seededRng(1)))

function caster(classId: 'mage' | 'priest', xp: number, ...spells: string[]): Hero {
  const h = createHero(classId === 'mage' ? 'Маг' : 'Жрец', classId, idx)
  gainXp(h, xp, idx)
  h.spellbook = spells
  h.mana = h.maxMana = 200
  return h
}
const cast = (hero: Hero, spellId: string, extra: Partial<Parameters<typeof castSpell>[0]> = {}) =>
  castSpell({ hero, spell: idx.spell(spellId), idx, heroes: [hero], combat: null, ...extra })

describe('аудит заклинаний героев', () => {
  it('усиления и защиты вне боя не накладываются (кроме «Удачи» и «Молитвы»)', () => {
    const m = caster('mage', 60000, 'mage-beskonechnaya-mana')
    expect(cast(m, 'mage-beskonechnaya-mana').ok).toBe(false)
    expect(m.buffs).toEqual([])
    const p = caster('priest', 60000, 'priest-udacha')
    expect(cast(p, 'priest-udacha').ok).toBe(true)
  })

  it('повторная «Сила» обновляет действие, а не складывается; «Слабость» дважды — атаки вдвое один раз', () => {
    const p = caster('priest', 60000, 'priest-sila', 'priest-slabost')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    cast(p, 'priest-sila', { combat: state, targetHeroUid: p.uid })
    cast(p, 'priest-sila', { combat: state, targetHeroUid: p.uid })
    expect(p.buffs.filter((b) => b.source === 'Сила')).toHaveLength(1)
    const ork = state.monsters[0]
    ork.noSave = true
    cast(p, 'priest-slabost', { combat: state, targetUid: ork.uid })
    const second = cast(p, 'priest-slabost', { combat: state, targetUid: ork.uid })
    expect(ork.attackMultiplier).toBe(0.5)
    expect(second.xp).toBe(0)
  })

  it('повторный «Призрачный доспех» не снимает защиту; повторная «Молитва» опыта не даёт', () => {
    const m = caster('mage', 6000, 'mage-prizrachnyy-dospeh')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const before = heroDefense(m, idx)
    cast(m, 'mage-prizrachnyy-dospeh', { combat: state })
    const armored = heroDefense(m, idx)
    expect(armored).toBeGreaterThan(before)
    cast(m, 'mage-prizrachnyy-dospeh', { combat: state })
    expect(heroDefense(m, idx)).toBe(armored)
    const p = caster('priest', 60000, 'priest-molitva')
    expect(cast(p, 'priest-molitva', { targetHeroUid: p.uid }).xp).toBeGreaterThan(0)
    expect(cast(p, 'priest-molitva', { targetHeroUid: p.uid }).xp).toBe(0)
  })

  it('«Валуны» мага 6 уровня — один валун в выбранную цель', () => {
    const m = caster('mage', 6000, 'mage-valuny')
    expect(m.level).toBeLessThan(8)
    const { state } = startCombat([{ monsterId: 'ork', count: 6 }], idx)
    for (const o of state.monsters) o.noSave = true
    const target = state.monsters[3]
    cast(m, 'mage-valuny', { combat: state, targetUid: target.uid })
    const hurt = state.monsters.filter((o) => o.lives < o.maxLives)
    expect(hurt).toEqual([target])
  })

  it('«Воздушная стена» защищает от стрел хазга', () => {
    const w = createHero('Воин', 'warrior', idx)
    w.buffs.push({ source: 'Воздушная стена', stat: 'ward', ward: 'air-wall', amount: 0, rounds: -1 })
    const { state } = startCombat([{ monsterId: 'hazg', count: 1 }], idx)
    setRng(() => 0.99)
    const log = monsterAttack(state.monsters[0], w, idx)
    expect(log[0].text).toContain('воздушной стены')
    expect(w.lives).toBe(w.maxLives)
  })

  it('погибший или потерявший сознание не колдует', () => {
    const p = caster('priest', 60000, 'priest-lechenie')
    p.lives = -10; p.status.dead = true
    expect(canCast(p, idx.spell('priest-lechenie'), idx)).toMatch(/погиб/)
  })

  it('«Восстановление» здорового не лечит и опыта не даёт', () => {
    const p = caster('priest', 60000, 'priest-vosstanovlenie')
    const r = cast(p, 'priest-vosstanovlenie', { targetHeroUid: p.uid })
    expect(r.ok).toBe(false)
    expect(p.xp).toBe(60000)
  })

  it('«Улучшение магического создания» не трогает спутника партии', () => {
    const m = caster('mage', 6000, 'mage-uluchshenie-magicheskogo-sozdaniya')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const knight = makeAlly(m.uid, 'Рыцарь', 14, '1к6', 14)
    knight.companionUid = 'comp1'
    state.allies.push(knight)
    expect(cast(m, 'mage-uluchshenie-magicheskogo-sozdaniya', { combat: state }).ok).toBe(false)
    expect(knight.lives).toBe(14)
  })

  it('«Вампиризм» поглощается огненным щитом монстра и опыта не даёт', () => {
    const p = caster('priest', 60000, 'priest-vampirizm')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const ork = state.monsters[0]
    ork.mana = 10
    ork.wards = [{ kind: 'antimagic', level: 6, rounds: 3, source: 'Огненный щит' }]
    const r = cast(p, 'priest-vampirizm', { combat: state, targetUid: ork.uid, param: 3 })
    expect(ork.mana).toBe(10)
    expect(r.xp).toBe(0)
  })

  it('«Землетрясение» бьёт ещё несколько раундов, «Рука смерти» не берёт мертвецов', () => {
    const m = caster('mage', 200000, 'mage-zemletryasenie', 'mage-ruka-smerti')
    const { state } = startCombat([{ monsterId: 'troll', count: 1 }], idx)
    const troll = state.monsters[0]
    troll.noSave = true; troll.lives = troll.maxLives = 500
    setRng(() => 0.99) // к6 = 6: ещё 5 раундов
    cast(m, 'mage-zemletryasenie', { combat: state })
    expect(troll.quake).toBe(5)
    const before = troll.lives
    state.turn = 'monsters'
    monstersTurn(state, [m], idx)
    expect(troll.lives).toBeLessThan(before)
    expect(troll.quake).toBe(4)
    const z = startCombat([{ monsterId: 'zombi', count: 1 }], idx).state
    z.monsters[0].noSave = true
    cast(m, 'mage-ruka-smerti', { combat: z, targetUid: z.monsters[0].uid })
    expect(z.monsters[0].lives).toBe(z.monsters[0].maxLives)
  })

  it('«Огненная ящерица»: жертва, выкинувшая удачу 12, теряет только 1к6', () => {
    const m = caster('mage', 6000, 'mage-ognennaya-yascheritsa')
    const { state } = startCombat([{ monsterId: 'troll', count: 1 }], idx)
    cast(m, 'mage-ognennaya-yascheritsa', { combat: state })
    const lizard = state.allies[0]
    expect(lizard.saveLuck).toBe(12)
    const troll = state.monsters[0]
    troll.lives = troll.maxLives = 500
    setRng(() => 0.99) // попадание, удача 18 ≥ 12, урон 1к6 = 6
    const log = alliesTurn(state, idx).map((e) => e.text).join(' ')
    expect(log).toContain('выкидывает удачу 12')
    expect(500 - troll.lives).toBeLessThanOrEqual(6)
  })

  it('«Трансформация энергии» лечит только самого мага, ввод «1» не мешает', () => {
    const m = caster('mage', 6000, 'mage-transformatsiya-energii')
    const friend = createHero('Воин', 'warrior', idx)
    friend.lives = 5; m.lives = m.maxLives - 3
    const r = castSpell({ hero: m, spell: idx.spell('mage-transformatsiya-energii'), idx, heroes: [m, friend], combat: null, targetHeroUid: friend.uid, param: 1 })
    expect(r.ok).toBe(true)
    expect(friend.lives).toBe(5)
    expect(m.lives).toBe(m.maxLives - 2)
  })
})
