// Регрессии по аудиту приключения: фонтаны, артефакты, ловушки, спутники, награды из книги, бросок по списку.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { idx } from '@/data'
import { seededRng, setRng } from '@/engine/dice'
import { rollSides } from '@/game/book'
import { COMMANDS, GameSession, blankGame } from '@/game/session'

const W = world as unknown as WorldMap
afterEach(() => setRng(seededRng(1)))

describe('аудит приключения', () => {
  it('фонтан Крепости короля назгулов (§ 22) — +5 жизней и раз в день; фонтан зала Чёрного мага — всё', () => {
    const s = new GameSession(blankGame(), W)
    const w = s.addHero('Воин', 'warrior')
    const p = s.addHero('Жрец', 'priest')
    w.lives = 1; p.mana = 0
    s.state.locationId = 'krepost-korolya-nazgulov'; s.markVisited('krepost-korolya-nazgulov', 22)
    s.drinkFountain()
    expect(w.lives).toBe(6)
    expect(p.mana).toBe(0)
    expect(() => s.drinkFountain()).toThrow(/сегодня уже пили/)
    s.state.locationId = 'zamok-chernogo-maga'; s.markVisited('zamok-chernogo-maga', 13)
    s.drinkFountain()
    expect(w.lives).toBe(w.maxLives)
    expect(p.mana).toBe(p.maxMana)
  })

  it('последний ненайденный артефакт находится всегда', () => {
    const s = new GameSession(blankGame(), W)
    const h = s.addHero('Воин', 'warrior')
    s.state.artifactsFound = idx.data.artifacts.map((a) => a.n).filter((n) => n !== 7)
    for (let seed = 1; seed < 30; seed++) {
      setRng(seededRng(seed))
      const g = new GameSession(JSON.parse(JSON.stringify(s.state)), W)
      expect(g.findArtifact(h.uid)).toBe(7)
    }
  })

  it('опыт за ловушку получает только вор', () => {
    const s = new GameSession(blankGame(), W)
    const w = s.addHero('Воин', 'warrior')
    const t = s.addHero('Вор', 'thief')
    expect(() => s.trapFound(w.uid)).toThrow(/только вор/)
    s.trapFound(t.uid)
    expect(t.xp).toBe(400)
  })

  it('бой спутника засчитывается только победой', () => {
    const s = new GameSession(blankGame(), W)
    const w = s.addHero('Воин', 'warrior')
    s.addCompanion('rytsar', 3)
    s.startEncounter([{ monsterId: 'ork', count: 1 }])
    s.state.combat!.escaped.push(w.uid)
    s.state.combat!.finished = 'fled'
    s.endCombat()
    expect(s.state.companions[0].battlesLeft).toBe(3)
  })

  it('награду из текста книги берут один раз на партию', () => {
    const s = new GameSession(blankGame(), W)
    expect(s.claim('zolotoy-gorod:22:c:20#1')).toBe(true)
    expect(() => s.claim('zolotoy-gorod:22:c:20#1')).toThrow(/уже взято/)
    // бросок по списку: одна группа на список, какое бы число ни выпало
    s.claim('zolotoy-gorod:2:1:0:roll=4')
    expect(() => s.claim('zolotoy-gorod:2:1:0:roll=1')).toThrow(/уже взято/)
  })

  it('отметки взятого: только для мест книги, снимаются при неудаче, на повторной встрече в пути сбрасываются; ставит ведущий', () => {
    const s = new GameSession(blankGame(), W)
    expect(() => s.claim('nowhere:1:c:5#1')).toThrow(/Нет такого места/)
    s.claim('zolotoy-gorod:22:0:c:20#1')
    s.unclaim('zolotoy-gorod:22:0:c:20#1')
    expect(s.claim('zolotoy-gorod:22:0:c:20#1')).toBe(true)
    expect(COMMANDS.claim).toBe('gm')
    // встреча «Дорога, § N» в новом походе: прежние отметки на ней не действуют, остальные остаются
    const road = idx.locationById.get('doroga')!.paragraphs.map((p) => p.n)
    const far = W.nodes.find((n) => n.locationId === 'zamok-chernogo-maga')!
    for (let seed = 1; seed < 60; seed++) {
      const g = new GameSession(blankGame(), W)
      g.state.claimed = road.map((n) => `doroga:${n}:0:b:6#1`)
      setRng(seededRng(seed))
      g.travelTo(far.id)
      if (!g.state.pendingRoad.length) continue
      for (const n of g.state.pendingRoad) expect(g.state.claimed).not.toContain(`doroga:${n}:0:b:6#1`)
      expect(g.state.claimed!.length).toBe(road.length - new Set(g.state.pendingRoad).size)
      return
    }
    throw new Error('ни одной встречи в пути за 60 попыток')
  })

  it('списки «для каждого» помечены для многократного броска, дома деревень «Дороги» — выбор любого из шести', () => {
    // «перед каждым черепом кидайте кубик»: бросок повторяется, а «дошли до конца» — отдельный выбор
    const p = idx.locationById.get('severnyy-fort')!.paragraphs.find((x) => x.n === 22)!
    expect(p.tree!.dice).toEqual({ sides: 6, repeat: true })
    expect(p.tree!.then!.find((c) => c.on === 'choice')!.label).toBe('Доходите до конца')
    for (const n of [54, 128]) {
      const tree = idx.locationById.get('doroga')!.paragraphs.find((x) => x.n === n)!.tree!
      expect(tree.exclusive, `doroga:${n}`).toBeUndefined()
      expect((tree.then ?? []).filter((c) => c.on === 'choice'), `doroga:${n}`).toHaveLength(6)
    }
  })

  it('кубик для списка: к3 для выбора одной из трёх, к6 и к18 по числам', () => {
    expect(rollSides([{ values: [1] }, { values: [2] }, { values: [3] }])).toBe(3)
    expect(rollSides([{ values: [1, 2] }])).toBe(6)
    expect(rollSides([{ values: [1, 2, 3] }, { values: [4, 5, 6] }])).toBe(6)
    expect(rollSides([{ values: [1] }, { values: [18] }])).toBe(18)
  })

  it('призрачный дракон несёт партию: следующий переход втрое быстрее, повторный вызов опыта не даёт', () => {
    const s = new GameSession(blankGame(), W)
    const m = s.addHero('Маг', 'mage')
    s.giveXp(m.uid, 100000); s.giveXp(m.uid, 100000)
    m.spellbook.push('mage-prizrachnyy-drakon'); m.mana = m.maxMana = 100
    const xp = m.xp
    expect(s.cast(m.uid, 'mage-prizrachnyy-drakon').ok).toBe(true)
    expect(s.state.flight).toBe(m.uid)
    const gained = m.xp - xp
    expect(gained).toBeGreaterThan(0)
    s.cast(m.uid, 'mage-prizrachnyy-drakon')
    expect(m.xp - xp).toBe(gained)
    const far = W.nodes.find((n) => n.id === 'zamok-chernogo-maga')!
    const day = s.state.day
    s.travelTo(far.id)
    const walked = s.state.log.at(-1)!.text
    expect(walked).toContain('на призрачном драконе')
    expect(s.state.flight).toBeUndefined()
    expect(s.state.day - day).toBeLessThanOrEqual(5)
  })

  it('в зале Чёрного мага ветка «Если попадаете» больше не выдаёт корону и артефакт второй раз', () => {
    const p = idx.locationById.get('zamok-chernogo-maga')!.paragraphs.find((x) => x.n === 13)!
    // корону и артефакт выдаёт сама дуэль (finalDuelAttack); этап победы открывается её отметкой и наград не несёт
    const branch = p.tree!.then!.find((g) => g.label === 'Если попадаете в Черного мага')!
    expect(branch.on).toBe('win')
    expect(p.tree!.action).toBe('final-duel')
    expect(branch.hints?.coins).toBeUndefined()
    expect(branch.hints?.artifact).toBeUndefined()
  })
})
