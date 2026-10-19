// Регрессии по аудиту приключения: фонтаны, артефакты, ловушки, спутники, награды из книги, бросок по списку.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { idx } from '@/data'
import { seededRng, setRng } from '@/engine/dice'
import { rollSides } from '@/game/book'
import { GameSession, blankGame } from '@/game/session'

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

  it('кубик для списка: к3 для выбора одной из трёх, к6 и к18 по числам', () => {
    expect(rollSides([{ values: [1] }, { values: [2] }, { values: [3] }])).toBe(3)
    expect(rollSides([{ values: [1, 2] }])).toBe(6)
    expect(rollSides([{ values: [1, 2, 3] }, { values: [4, 5, 6] }])).toBe(6)
    expect(rollSides([{ values: [1] }, { values: [18] }])).toBe(18)
  })

  it('в зале Чёрного мага ветка «Если попадаете» больше не выдаёт корону и артефакт второй раз', () => {
    const p = idx.locationById.get('zamok-chernogo-maga')!.paragraphs.find((x) => x.n === 13)!
    const branch = p.segments!.find((g) => g.label === 'Если попадаете в Черного мага')!
    expect(branch.hints?.coins).toBeUndefined()
    expect(branch.hints?.artifact).toBeUndefined()
  })
})
