import { beforeEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { arrowsLeft, createHero, gainXp, hasWard, heroWeapons } from '@/engine/character'
import { buy, equip } from '@/engine/inventory'
import { seededRng, setRng } from '@/engine/dice'
import { checkEnd, closeToMelee, heroAttack, heroFlee, monstersTurn, regrowHeads, startCombat, finishCombat } from '@/engine/combat'
import { castSpell, resolveCost } from '@/engine/spells'
import { addToInventory } from '@/engine/inventory'

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
    closeToMelee(state, heroes, idx)
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
    buy(w, 'weapon', 'strela', idx, 5)
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
    closeToMelee(state, [w], idx)
    let escaped = false
    for (let i = 0; i < 50 && !escaped; i++) {
      heroFlee(state, w, [w], idx)
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

  it('контроль: засыпание усыпляет орка, по спящему попадают автоматически', () => {
    const m = createHero('Маг', 'mage', idx)
    gainXp(m, 1000, idx); m.mana = m.maxMana
    m.spellbook.push('mage-zasypanie')
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    equip(w, buy(w, 'weapon', 'mech-korotkiy', idx).uid, idx)
    const heroes = [m, w]
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const t = state.monsters[0]
    t.noSave = true
    const res = castSpell({ hero: m, spell: idx.spell('mage-zasypanie'), idx, heroes, combat: state, targetUid: t.uid })
    expect(res.ok).toBe(true)
    expect(t.disabled).toBe(2); expect(t.disabledKind).toBe('sleep')
    closeToMelee(state, heroes, idx)
    const out = heroAttack(state, w, heroes, 'rightHand', t.uid, idx)
    expect(out.hit).toBe(true)
  })

  it('призыв: пантера сражается на стороне героев и бьёт в ход монстров', () => {
    const m = createHero('Маг', 'mage', idx)
    gainXp(m, 15000, idx); m.mana = m.maxMana
    m.spellbook.push('mage-prizrachnaya-pantera')
    const { state } = startCombat([{ monsterId: 'kobold', count: 1 }], idx)
    const res = castSpell({ hero: m, spell: idx.spell('mage-prizrachnaya-pantera'), idx, heroes: [m], combat: state })
    expect(res.ok).toBe(true); expect(res.xp).toBe(300)
    expect(state.allies).toHaveLength(1); expect(state.allies[0].attacks).toBe('1к18')
    closeToMelee(state, [m], idx)
    state.turn = 'monsters'
    let guard = 0
    while (!state.finished && guard++ < 50) { monstersTurn(state, [m], idx); state.turn = 'monsters' }
    expect(state.finished).toBeDefined()
  })

  it('магическое оружие: огненный меч жреца бьёт по формуле 1к6+4 с ловкостью +2', () => {
    const p = createHero('Жрец', 'priest', idx)
    gainXp(p, 20000, idx); p.mana = p.maxMana
    p.spellbook.push('priest-ognennyy-mech')
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    closeToMelee(state, [p], idx)
    const res = castSpell({ hero: p, spell: idx.spell('priest-ognennyy-mech'), idx, heroes: [p], combat: state })
    expect(res.ok).toBe(true)
    const weapons = heroWeapons(p, idx)
    expect(weapons.find((w) => w.slot === 'spell')?.formula).toBe('1к6+4')
    const out = heroAttack(state, p, [p], 'spell', state.monsters[0].uid, idx)
    expect(out.log.length).toBeGreaterThan(0)
    if (out.hit) expect(out.damage).toBeGreaterThanOrEqual(5)
  })

  it('неуязвимость: атаки монстров не вредят', () => {
    const p = createHero('Жрец', 'priest', idx)
    gainXp(p, 60000, idx); p.mana = p.maxMana
    p.spellbook.push('priest-neuyazvimost')
    const { state } = startCombat([{ monsterId: 'ork', count: 3 }], idx)
    closeToMelee(state, [p], idx)
    castSpell({ hero: p, spell: idx.spell('priest-neuyazvimost'), idx, heroes: [p], combat: state })
    expect(hasWard(p, 'invulnerable')).toBeDefined()
    const before = p.lives
    state.turn = 'monsters'
    monstersTurn(state, [p], idx)
    expect(p.lives).toBe(before)
  })

  it('воин 12 уровня действует дважды за раунд', () => {
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    gainXp(w, 60000, idx)
    equip(w, buy(w, 'weapon', 'mech-korotkiy', idx).uid, idx)
    const { state } = startCombat([{ monsterId: 'chernyy-drakon', count: 1 }], idx)
    closeToMelee(state, [w], idx)
    expect(state.extraActions[w.uid]).toBe(1)
    heroAttack(state, w, [w], 'rightHand', state.monsters[0].uid, idx)
    expect(state.turn).toBe('heroes'); expect(state.acted).not.toContain(w.uid)
    heroAttack(state, w, [w], 'rightHand', state.monsters[0].uid, idx)
    expect(state.turn).toBe('monsters')
  })

  it('оживление персонажа возвращает мёртвого героя', () => {
    const p = createHero('Жрец', 'priest', idx)
    gainXp(p, 60000, idx); p.mana = p.maxMana
    p.spellbook.push('priest-ozhivlenie-personazha')
    const w = createHero('Воин', 'warrior', idx)
    w.lives = -10; w.status.dead = true; w.status.unconscious = true
    const res = castSpell({ hero: p, spell: idx.spell('priest-ozhivlenie-personazha'), idx, heroes: [p, w], targetHeroUid: w.uid })
    expect(res.ok).toBe(true); expect(w.status.dead).toBeFalsy(); expect(w.lives).toBe(w.maxLives); expect(res.xp).toBe(550)
  })

  it('опознание предмета: бутылка становится известной (кроме 1/6 ошибки)', () => {
    const m = createHero('Маг', 'mage', idx)
    gainXp(m, 4000, idx); m.mana = m.maxMana
    m.spellbook.push('mage-identifikatsiya-predmetov')
    const w = createHero('Воин', 'warrior', idx)
    const b = addToInventory(w, 'bottle', '5', 1, { identified: false })
    const res = castSpell({ hero: m, spell: idx.spell('mage-identifikatsiya-predmetov'), idx, heroes: [m, w], targetEntryUid: b.uid })
    expect(res.ok).toBe(true); expect(res.manaSpent).toBe(2)
    expect(res.log.some((e) => /Опознание бутылки/.test(e.text))).toBe(true)
  })

  it('магия монстров: ведьма с маной колдует по героям', () => {
    const w = createHero('Воин', 'warrior', idx)
    const { state } = startCombat([{ monsterId: 'vedma', count: 1 }], idx)
    closeToMelee(state, [w], idx)
    state.turn = 'monsters'
    let casts = 0
    for (let i = 0; i < 30 && !state.finished; i++) {
      const log = monstersTurn(state, [w], idx)
      if (log.some((e) => /произносит/.test(e.text))) casts++
      state.turn = 'monsters'
      w.lives = w.maxLives; w.status = {}
    }
    expect(casts).toBeGreaterThan(0)
    expect(state.monsters[0].mana!).toBeLessThan(14)
  })

  it('стрелы: без стрел лук не стреляет; эльфийские расходуются первыми и дают +3', () => {
    const t = createHero('Вор', 'thief', idx); t.money = 500
    equip(t, buy(t, 'weapon', 'korotkiy-luk', idx).uid, idx)
    const { state } = startCombat([{ monsterId: 'chernyy-drakon', count: 1 }], idx)
    const target = state.monsters[0]
    const none = heroAttack(state, t, [t], 'ranged', target.uid, idx)
    expect(none.log[0].text).toMatch(/стрелы кончились/)
    expect(state.acted).toHaveLength(0)
    buy(t, 'weapon', 'strela', idx, 3)
    buy(t, 'weapon', 'elfiyskaya-strela', idx, 1)
    const bow = heroWeapons(t, idx).find((w) => w.slot === 'ranged')!
    expect(bow.ammoEntry?.ref).toBe('elfiyskaya-strela'); expect(bow.accuracyBonus).toBe(3); expect(bow.ammoLeft).toBe(4)
    heroAttack(state, t, [t], 'ranged', target.uid, idx)
    expect(arrowsLeft(t)).toBe(3)
    expect(t.inventory.some((e) => e.ref === 'elfiyskaya-strela')).toBe(false)
  })

  it('дротики и копьё улетают при броске и подбираются после победы', () => {
    const w = createHero('Воин', 'warrior', idx); w.money = 500
    const darts = buy(w, 'weapon', 'drotik', idx, 3)
    equip(w, darts.uid, idx)
    const spear = buy(w, 'weapon', 'kope', idx)
    const { state } = startCombat([{ monsterId: 'kobold', count: 1 }], idx)
    heroAttack(state, w, [w], 'ranged', state.monsters[0].uid, idx)
    expect(w.inventory.find((e) => e.ref === 'drotik')?.qty).toBe(2)
    expect(state.recover[w.uid].drotik).toBe(1)
    // копьё в слот метательного, бросок в ближнем бою разрешён
    equip(w, spear.uid, idx, 'ranged')
    expect(w.equipment.ranged).toBe(spear.uid)
    state.acted = []; state.turn = 'heroes'
    if (!state.finished) heroAttack(state, w, [w], 'ranged', state.monsters[0].uid, idx)
    expect(w.inventory.some((e) => e.ref === 'kope')).toBe(state.finished === 'victory' && !state.recover[w.uid].kope)
    state.finished = 'victory'
    finishCombat(state, [w], idx)
    expect(w.inventory.find((e) => e.ref === 'drotik')?.qty).toBe(3)
    expect(w.inventory.some((e) => e.ref === 'kope')).toBe(true)
  })

  it('гидра: девять голов по одной жизни, отрубленная голова отрастает без опыта', () => {
    const w = createHero('Воин', 'warrior', idx)
    const { state } = startCombat([{ monsterId: 'gidra', count: 1 }], idx)
    expect(state.monsters).toHaveLength(9)
    expect(state.monsters.every((m) => m.lives === 1 && m.groupId === state.monsters[0].groupId)).toBe(true)
    state.monsters[0].dead = true; state.monsters[0].lives = 0
    const log = regrowHeads(state)
    expect(log).toHaveLength(1)
    expect(state.monsters[0].dead).toBe(false); expect(state.monsters[0].points).toBe(0)
    for (const m of state.monsters) { m.dead = true; m.lives = 0 }
    expect(regrowHeads(state)).toHaveLength(0)
    checkEnd(state, [w]); expect(state.finished).toBe('victory')
    const ogre = startCombat([{ monsterId: 'ogr', count: 1 }], idx).state.monsters
    expect(ogre).toHaveLength(1); expect(ogre[0].lives).toBe(16)
  })
})
