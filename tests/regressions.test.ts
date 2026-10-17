// Регрессии по итогам ревью движка (2026-10-17): каждый тест — сценарий найденной ошибки.
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { idx } from '@/data'
import { createHero, gainXp, hasWard } from '@/engine/character'
import { addToInventory, buy, equip } from '@/engine/inventory'
import { seededRng, setRng } from '@/engine/dice'
import { applyExtraAttack, closeToMelee, endHeroesTurn, loseControl, makeMonsterInstance, markActed, monsterAttack, monsterCast, monstersTurn, startCombat, tickHeroStatus } from '@/engine/combat'
import { castSpell } from '@/engine/spells'
import type { LogEntry } from '@/engine/model'

const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0,
} as Storage
const { useGameStore } = await import('@/stores/game')

const caster = (classId: 'mage' | 'priest', xp: number, spell: string) => {
  const h = createHero(classId === 'mage' ? 'Маг' : 'Жрец', classId, idx)
  gainXp(h, xp, idx); h.mana = h.maxMana; h.pendingSpellPicks = 0
  if (!h.spellbook.includes(spell)) h.spellbook.push(spell)
  return h
}

describe('регрессии ревью движка', () => {
  beforeEach(() => { setRng(seededRng(77)); mem.clear(); setActivePinia(createPinia()) })

  it('1. сбежавший воин с запасным действием не подвешивает раунд', () => {
    const w = createHero('Воин', 'warrior', idx); gainXp(w, 60000, idx)
    const m = createHero('Маг', 'mage', idx)
    const heroes = [w, m]
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    closeToMelee(state, heroes, idx)
    state.turn = 'heroes'; state.acted = [m.uid]; state.extraActions[w.uid] = 1
    state.escaped.push(w.uid)
    markActed(state, w, heroes, idx)
    expect(state.turn).toBe('monsters')
  })

  it('1б. «Закончить ход героев» всегда двигает бой дальше', () => {
    const w = createHero('Воин', 'warrior', idx)
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    endHeroesTurn(state, [w], idx)
    expect(state.phase).toBe('melee')
    state.turn = 'heroes'; state.acted = []
    endHeroesTurn(state, [w], idx)
    expect(state.turn).toBe('monsters')
  })

  it('2. «Замедление времени» даёт ровно одно дополнительное действие', () => {
    const p = caster('priest', 30000, 'priest-zamedlenie-vremeni')
    const w = createHero('Воин', 'warrior', idx)
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    closeToMelee(state, [p, w], idx); state.turn = 'heroes'; state.acted = [w.uid]
    castSpell({ hero: p, spell: idx.spell('priest-zamedlenie-vremeni'), idx, heroes: [p, w], combat: state, targetHeroUid: w.uid })
    expect(state.acted).not.toContain(w.uid)
    expect(state.extraActions[w.uid] ?? 0).toBe(0)
  })

  it('3. паралич героя длится полные N раундов', () => {
    const w = createHero('Воин', 'warrior', idx)
    const log: LogEntry[] = []
    applyExtraAttack(w, 'paralysis', log)
    const n = w.status.paralysis!
    tickHeroStatus(w) // конец того же хода монстров — отсчёт не идёт
    expect(w.status.paralysis).toBe(n)
    tickHeroStatus(w)
    expect(w.status.paralysis).toBe(n - 1)
  })

  it('4. атака «смерть» без указанной удачи убивает без спасброска', () => {
    const gub = makeMonsterInstance(idx.monster('gubitel'), 0)
    let hits = 0
    for (let i = 0; i < 60 && hits === 0; i++) {
      const w = createHero('Воин', 'warrior', idx)
      w.luck = 30
      const log = monsterAttack(gub, w, idx)
      if (!log.some((e) => /промах/.test(e.text))) { hits++; expect(w.status.dead).toBe(true) }
    }
    expect(hits).toBe(1)
  })

  it('5. «Воздушный щит» — общий запас на партию и пропускает слишком сильное заклинание', () => {
    const m = caster('mage', 15000, 'mage-vozdushnyy-schit')
    const a = createHero('А', 'warrior', idx), b = createHero('Б', 'thief', idx)
    const heroes = [m, a, b]
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    castSpell({ hero: m, spell: idx.spell('mage-vozdushnyy-schit'), idx, heroes, combat: state })
    for (const h of heroes) hasWard(h, 'spell-shield')!.charge = 4
    const witch = makeMonsterInstance(idx.monster('ork'), 0)
    witch.attacks = 'magic'; witch.mana = 100; witch.spells = ['огненное копье'] // 3 уровень
    const first = monsterCast(state, witch, heroes, idx)!
    expect(first.some((e) => /поглощает/.test(e.text))).toBe(true)
    for (const h of heroes) expect(hasWard(h, 'spell-shield')?.charge).toBe(1)
    const second = monsterCast(state, witch, heroes, idx)!
    expect(second.some((e) => /поглощает/.test(e.text))).toBe(false)
  })

  it('6. заклинания монстров не находят невидимого героя', () => {
    const w = createHero('Воин', 'warrior', idx)
    w.buffs.push({ source: 'Невидимость', stat: 'ward', ward: 'invisible', amount: 0, rounds: 5 })
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const mage = makeMonsterInstance(idx.monster('ork'), 0)
    mage.attacks = 'magic'; mage.mana = 100; mage.spells = ['огненное копье']
    const log = monsterCast(state, mage, [w], idx)!
    expect(log.some((e) => /цели не видно/.test(e.text))).toBe(true)
    expect(w.lives).toBe(w.maxLives)
  })

  it('7. опыт за урон окаменения достаётся магу', () => {
    const m = caster('mage', 10000, 'mage-okamenenie')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const orc = state.monsters[0]; orc.noSave = true
    castSpell({ hero: m, spell: idx.spell('mage-okamenenie'), idx, heroes: [m], combat: state, targetUid: orc.uid })
    const before = m.xp
    for (let i = 0; i < 20 && !orc.dead; i++) { state.turn = 'monsters'; monstersTurn(state, [m], idx) }
    expect(orc.dead).toBe(true)
    expect(m.xp - before).toBe(orc.maxLives * orc.points)
  })

  it('8. заклинание без эффекта не даёт опыта', () => {
    const m = caster('mage', 1000, 'mage-zasypanie')
    const { state } = startCombat([{ monsterId: 'chernyy-drakon', count: 1 }], idx)
    const res = castSpell({ hero: m, spell: idx.spell('mage-zasypanie'), idx, heroes: [m], combat: state, targetUid: state.monsters[0].uid })
    expect(res.ok).toBe(true); expect(res.xp).toBe(0)
  })

  it('9. лечение мёртвого героя не тратит ману', () => {
    const p = caster('priest', 0, 'priest-lechenie')
    const w = createHero('Воин', 'warrior', idx)
    w.lives = -10; w.status.dead = true
    const res = castSpell({ hero: p, spell: idx.spell('priest-lechenie'), idx, heroes: [p, w], targetHeroUid: w.uid, param: 3 })
    expect(res.ok).toBe(false); expect(p.mana).toBe(p.maxMana)
  })

  it('10. артефакты подчиняются ограничениям класса и рук', () => {
    const m = createHero('Маг', 'mage', idx)
    expect(() => equip(m, addToInventory(m, 'artifact', '6').uid, idx)).toThrow() // Топор Крома
    const p = createHero('Жрец', 'priest', idx)
    expect(() => equip(p, addToInventory(p, 'artifact', '7').uid, idx)).toThrow() // Радужный лук
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    equip(w, buy(w, 'weapon', 'mech-dvuruchnyy', idx).uid, idx)
    expect(() => equip(w, addToInventory(w, 'artifact', '10').uid, idx)).toThrow() // щит Ирлинора
    // щит доступен и магу (ХАУСРУЛ): книга ограничивает только оружие
    m.money = 100
    equip(m, buy(m, 'weapon', 'kinzhal', idx).uid, idx)
    expect(equip(m, buy(m, 'armor', 'schit', idx).uid, idx)).toBe('shield')
  })

  it('11. «Прервать» снимает боевые статусы и баффы', () => {
    const s = useGameStore()
    s.newGame()
    const w = s.addHero('Воин', 'warrior')
    s.startEncounter([{ monsterId: 'ork', count: 1 }])
    const h = s.hero(w.uid)
    h.status.paralysis = 3; h.status.petrified = true
    h.buffs.push({ source: 'Огненный меч', stat: 'weapon', amount: 0, rounds: -1, weapon: { name: 'Огненный меч', attacks: '1к6+4' } })
    s.abortCombat()
    expect(s.combat).toBeNull()
    expect(h.status.paralysis).toBeUndefined(); expect(h.status.petrified).toBeUndefined(); expect(h.buffs).toEqual([])
  })

  it('мелочи: опыт заклинаний входит в итог боя, «Бесконечная мана» восполняет ману', () => {
    const m = caster('mage', 4000, 'mage-magicheskaya-strela')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    state.monsters[0].noSave = true
    const r = castSpell({ hero: m, spell: idx.spell('mage-magicheskaya-strela'), idx, heroes: [m], combat: state, targetUid: state.monsters[0].uid, param: 1 })
    expect(state.xpEarned[m.uid]).toBe(r.xp)
    const m8 = caster('mage', 20000, 'mage-beskonechnaya-mana')
    m8.mana = 11
    castSpell({ hero: m8, spell: idx.spell('mage-beskonechnaya-mana'), idx, heroes: [m8], combat: state, targetHeroUid: m8.uid })
    expect(m8.mana).toBe(m8.maxMana)
  })

  it('Молитва: +3 к следующему броску героя, затем снимается', () => {
    const p = caster('priest', 7000, 'priest-molitva')
    castSpell({ hero: p, spell: idx.spell('priest-molitva'), idx, heroes: [p], targetHeroUid: p.uid })
    expect(hasWard(p, 'prayer')).toBeDefined()
    const s = useGameStore(); s.newGame(); s.game!.heroes.push(p)
    s.luckCheck(p.uid, 5)
    expect(hasWard(p, 'prayer')).toBeUndefined()
  })

  it('Двойник копирует защиту и жизни героя и сражается за партию', () => {
    const m = caster('mage', 40000, 'mage-dvoynik')
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    equip(w, buy(w, 'weapon', 'mech-dlinnyy', idx).uid, idx)
    equip(w, buy(w, 'armor', 'laty', idx).uid, idx)
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    castSpell({ hero: m, spell: idx.spell('mage-dvoynik'), idx, heroes: [m, w], combat: state, targetHeroUid: w.uid })
    expect(state.allies).toHaveLength(1)
    expect(state.allies[0].defense).toBe(15); expect(state.allies[0].lives).toBe(w.maxLives)
    expect(state.allies[0].attacks).toBe('3-4-5-6-7-8')
  })

  it('Отражение магии возвращает заклинание монстру', () => {
    const m = caster('mage', 40000, 'mage-otrazhenie-magii')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    castSpell({ hero: m, spell: idx.spell('mage-otrazhenie-magii'), idx, heroes: [m], combat: state })
    const foe = makeMonsterInstance(idx.monster('troll'), 0)
    foe.attacks = 'magic'; foe.mana = 100; foe.spells = ['огненное копье']
    state.monsters.push(foe)
    const before = foe.lives
    const log = monsterCast(state, foe, [m], idx)!
    expect(log.some((e) => /отражает/.test(e.text))).toBe(true)
    expect(m.lives).toBe(m.maxLives)
    expect(foe.lives).toBeLessThan(before)
    expect(hasWard(m, 'reflect')).toBeUndefined()
  })

  it('Удвоение жидкости и Несчастье', () => {
    const m = caster('mage', 2000, 'mage-udvoenie-zhidkosti')
    const b = addToInventory(m, 'bottle', '6', 1, { identified: true })
    castSpell({ hero: m, spell: idx.spell('mage-udvoenie-zhidkosti'), idx, heroes: [m], targetEntryUid: b.uid })
    expect(m.inventory.find((e) => e.kind === 'bottle')?.qty).toBe(2)
    const m8 = caster('mage', 20000, 'mage-neschaste')
    const { state } = startCombat([{ monsterId: 'troll', count: 1 }], idx)
    state.monsters[0].noSave = true
    castSpell({ hero: m8, spell: idx.spell('mage-neschaste'), idx, heroes: [m8], combat: state, targetUid: state.monsters[0].uid })
    expect(state.monsters[0].cursed).toBe(true)
    state.turn = 'monsters'
    expect(() => monstersTurn(state, [m8], idx)).not.toThrow()
  })

  it('Оживление мертвеца: нужен труп, зомби может выйти из-под контроля', () => {
    const m = caster('mage', 4000, 'mage-ozhivlenie-mertvetsa')
    const { state } = startCombat([{ monsterId: 'ork', count: 2 }], idx)
    const no = castSpell({ hero: m, spell: idx.spell('mage-ozhivlenie-mertvetsa'), idx, heroes: [m], combat: state })
    expect(no.ok).toBe(false); expect(m.mana).toBe(m.maxMana)
    state.monsters[0].dead = true; state.monsters[0].lives = 0
    const yes = castSpell({ hero: m, spell: idx.spell('mage-ozhivlenie-mertvetsa'), idx, heroes: [m], combat: state })
    expect(yes.ok).toBe(true); expect(state.allies[0].unstable).toBe('zombie')
    const outcomes = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const st = startCombat([{ monsterId: 'ork', count: 1 }], idx).state
      const z = { ...state.allies[0], dead: false }
      st.allies.push(z)
      const log = loseControl(st, z, idx)
      outcomes.add(log[0].text.includes('уходит') ? 'ушёл' : log[0].text.includes('нападает') ? 'напал' : 'прах')
      if (log[0].text.includes('нападает')) expect(st.monsters.some((x) => /Зомби/.test(x.name))).toBe(true)
    }
    expect(outcomes.size).toBe(3)
  })
})
