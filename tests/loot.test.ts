// Трофеи после боя: таблица по Бестиарию, сбор после победы, продажа.
import { describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { checkEnd, startCombat } from '@/engine/combat'
import { createHero } from '@/engine/character'
import { addToInventory, salePrice, sell } from '@/engine/inventory'
import { MONSTER_LOOT, TROPHIES, collectLoot } from '@/engine/loot'
import { GameSession, blankGame } from '@/game/session'

describe('трофеи', () => {
  it('таблица ссылается на существующих монстров, оружие, доспехи и трофеи', () => {
    for (const [id, items] of Object.entries(MONSTER_LOOT)) {
      expect(idx.monsterById.get(id), id).toBeDefined()
      for (const it of items) {
        if (it.kind === 'weapon') expect(idx.weaponById.get(it.ref), it.ref).toBeDefined()
        else if (it.kind === 'armor') expect(idx.armor(it.ref), it.ref).toBeDefined()
        else expect(TROPHIES[it.ref], it.ref).toBeDefined()
      }
    }
  })

  it('после победы с убитых снимается снаряжение, сбежавшие и окаменевшие ничего не оставляют', () => {
    const { state } = startCombat([{ monsterId: 'strazhnik', count: 1 }, { monsterId: 'razboynik', count: 2 }], idx)
    const [guard, r1, r2] = state.monsters
    guard.dead = true; r1.dead = true; r2.dead = true; r2.petrified = true
    checkEnd(state, [createHero('Воин', 'warrior', idx)])
    expect(state.finished).toBe('victory')
    expect(state.loot?.map((x) => x.ref).sort()).toEqual(['kinzhal', 'mech-korotkiy', 'schit'])
    expect(state.loot?.find((x) => x.ref === 'schit')?.from).toBe(guard.name)
    expect(collectLoot([{ ...r1, dead: false, fled: true }])).toEqual([])
  })

  it('герой забирает трофей командой, второй раз его не взять, остальное остаётся на поле', () => {
    const s = new GameSession(blankGame(), null)
    s.addHero('Ветра', 'warrior')
    const h = s.state.heroes[0]
    s.startEncounter([{ monsterId: 'berserker', count: 1 }])
    const c = s.state.combat!
    c.monsters[0].dead = true
    checkEnd(c, s.state.heroes)
    expect(c.loot).toHaveLength(2)
    const [first, second] = c.loot!
    const swords = () => h.inventory.filter((e) => e.ref === 'mech-korotkiy').length
    const before = swords()
    s.takeLoot(h.uid, first.uid)
    expect(swords()).toBe(before + 1)
    expect(s.state.log.at(-1)?.text).toBe('Ветра забирает трофей: меч короткий (Берсеркер).')
    expect(() => s.takeLoot(h.uid, first.uid)).toThrow('уже забрали')
    expect(c.loot!.map((x) => x.uid)).toEqual([second.uid])
    s.endCombat()
    expect(s.state.log.some((e) => e.text.includes('На поле боя остались трофеи: меч короткий'))).toBe(true)
  })

  it('трофеи не собрать, пока бой не выигран', () => {
    const s = new GameSession(blankGame(), null)
    s.addHero('Ветра', 'warrior')
    s.startEncounter([{ monsterId: 'ork', count: 1 }])
    expect(() => s.takeLoot(s.state.heroes[0].uid, 'nope')).toThrow('после победы')
  })

  it('шкуры и ятаганы продаются по цене из Бестиария, оружие — за половину', () => {
    const h = createHero('Вор', 'thief', idx)
    const money = h.money
    const hide = addToInventory(h, 'trophy', 'shkura-sablezubogo-tigra')
    addToInventory(h, 'trophy', 'shkura-sablezubogo-tigra')
    expect(hide.qty).toBe(2)
    expect(salePrice(hide, idx)).toBe(50)
    expect(sell(h, hide.uid, idx, 2)).toBe(100)
    const dagger = addToInventory(h, 'weapon', 'kinzhal')
    expect(salePrice(dagger, idx)).toBe(7)
    expect(h.money).toBe(money + 100)
  })
})
