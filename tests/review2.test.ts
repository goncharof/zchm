// Регрессии по второму ревью (2026-10-18): движок, сессия, команды из сети.
import { describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { checkEnd } from '@/engine/combat'
import { gainXp } from '@/engine/character'
import { addToInventory } from '@/engine/inventory'
import { seededRng, setRng } from '@/engine/dice'
import { GameSession, blankGame } from '@/game/session'

function party() {
  setRng(seededRng(11))
  const s = new GameSession(blankGame(), null)
  const a = s.addHero('Конан', 'warrior')
  const b = s.addHero('Бильбо', 'thief')
  return { s, a, b }
}
const win = (s: GameSession) => { for (const m of s.state.combat!.monsters) m.dead = true; checkEnd(s.state.combat!, s.state.heroes) }

describe('второе ревью', () => {
  it('передача вещи сохраняет количество и сливается со стопкой', () => {
    const { s, a, b } = party()
    const arrows = addToInventory(b, 'weapon', 'strela', 10)
    addToInventory(a, 'weapon', 'strela', 3)
    s.transferItem(b.uid, a.uid, arrows.uid)
    expect(a.inventory.filter((e) => e.ref === 'strela').map((e) => e.qty)).toEqual([13])
    expect(b.inventory.some((e) => e.ref === 'strela')).toBe(false)
  })

  it('новый бой поверх оконченного сначала подводит итог прошлого', () => {
    const { s, a } = party()
    s.startEncounter([{ monsterId: 'kobold', count: 1 }])
    s.state.combat!.recover[a.uid] = { drotik: 2 }
    a.status.paralysis = 2
    win(s)
    s.startEncounter([{ monsterId: 'ork', count: 1 }])
    expect(a.inventory.find((e) => e.ref === 'drotik')?.qty).toBeGreaterThanOrEqual(2)
    expect(a.status.paralysis).toBeUndefined()
    expect(s.state.combat!.monsters[0].monsterId).toBe('ork')
  })

  it('герой действует один раз за раунд и не в ход монстров; «Сойтись вплотную» дважды не перебрасывает инициативу', () => {
    const { s, a, b } = party()
    s.startEncounter([{ monsterId: 'ork', count: 2 }])
    s.toMelee()
    const ini = s.state.combat!.initiative
    s.toMelee()
    expect(s.state.combat!.initiative).toEqual(ini)
    const c = s.state.combat!
    if (c.turn === 'monsters') s.monstersAct()
    const target = c.monsters.find((m) => !m.dead)!.uid
    s.attack(a.uid, 'rightHand', target)
    if (!c.finished) expect(() => s.attack(a.uid, 'rightHand', c.monsters.find((m) => !m.dead)!.uid)).toThrow(/уже сходил/)
    if (!c.finished && c.turn === 'heroes') s.skip(b.uid)
    if (!c.finished && c.turn === 'monsters') expect(() => s.skip(a.uid)).toThrow(/ход монстров/)
  })

  it('бой нельзя закрыть, пока он идёт; в оконченный нельзя добавить монстров', () => {
    const { s } = party()
    s.startEncounter([{ monsterId: 'ork', count: 1 }])
    expect(() => s.endCombat()).toThrow(/ещё идёт/)
    win(s)
    expect(() => s.addMonstersToCombat([{ monsterId: 'ork', count: 1 }])).toThrow(/окончен/)
    s.endCombat()
    expect(s.state.combat).toBeNull()
  })

  it('«Оживление мертвеца» поднимает каждое тело один раз', () => {
    const { s } = party()
    const m = s.addHero('Мерлин', 'mage')
    gainXp(m, 20000, idx); m.mana = m.maxMana; m.pendingSpellPicks = 0
    m.spellbook.push('mage-ozhivlenie-mertvetsa')
    s.startEncounter([{ monsterId: 'razboynik', count: 2 }])
    const c = s.state.combat!
    c.monsters[0].dead = true
    c.phase = 'melee'
    const first = s.cast(m.uid, 'mage-ozhivlenie-mertvetsa')
    expect(first.ok).toBe(true)
    c.acted = []
    const again = s.cast(m.uid, 'mage-ozhivlenie-mertvetsa')
    expect(again.ok).toBe(false)
    expect(c.allies.filter((x) => x.monsterId === 'zombi')).toHaveLength(1)
  })

  it('количества из команд проверяются; артефакт нельзя выбросить или продать; палицу-артефакт не смазать ядом', () => {
    const { s, a } = party()
    const sword = addToInventory(a, 'weapon', 'mech-korotkiy')
    expect(() => s.sellItem(a.uid, sword.uid, 50)).toThrow(/количество/)
    expect(() => s.dropItem(a.uid, sword.uid, -5)).toThrow(/количество/)
    expect(() => s.buyItem(a.uid, 'weapon', 'kinzhal', -3)).toThrow(/количество/)
    const art = addToInventory(a, 'artifact', '4') // Палица друидов
    expect(() => s.dropItem(a.uid, art.uid, 1)).toThrow(/Артефакт/)
    expect(() => s.sellItem(a.uid, art.uid, 1)).toThrow(/Артефакт/)
    addToInventory(a, 'item', 'yad')
    expect(() => s.poisonWeapon(a.uid, art.uid)).toThrow(/Палицы/)
  })
})
