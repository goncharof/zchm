// Дерево этапов параграфа (src/game/tree.ts): старая разметка → дерево без потерь, открытие этапов по отметкам.
import { describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { paragraphText, treeText } from '@/game/book'
import { allNodes, openChoices, openNodes, paragraphTree, revealedBy } from '@/game/tree'
import { GameSession, blankGame } from '@/game/session'
import { checkEnd } from '@/engine/combat'
import { seededRng, setRng } from '@/engine/dice'

const words = (t: string) => (t.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\d]+/gu) ?? []).sort()
const para = (loc: string, n: number) => idx.locationById.get(loc)!.paragraphs.find((p) => p.n === n)!

describe('дерево этапов', () => {
  it('дерево каждого параграфа содержит весь его текст, слово в слово', () => {
    for (const l of idx.data.locations) for (const p of l.paragraphs) {
      expect(words(treeText(paragraphTree(p))), `${l.id} §${p.n}`).toEqual(words(paragraphText(p)))
    }
  })

  it('id этапов уникальны в параграфе', () => {
    for (const l of idx.data.locations) for (const p of l.paragraphs) {
      const ids = allNodes(paragraphTree(p)).map((n) => n.id)
      expect(new Set(ids).size, `${l.id} §${p.n}`).toBe(ids.length)
    }
  })

  it('Золотой город § 2: исходы удачи и боя закрыты до проверки и боя, вариант — по выбору', () => {
    const t = paragraphTree(para('zolotoy-gorod', 2))
    const P = 'zolotoy-gorod:2'
    expect(openNodes(t, P).map((n) => n.id)).toEqual(['0'])
    expect(openChoices(t, P).map((n) => n.label)).toEqual(['Если вы решили помочь стражникам, бросьте кубик'])
    const marks = [`${P}:1:open`]
    expect(openNodes(t, P, marks).map((n) => n.id)).toEqual(['0', '1'])
    // бросок списка ветки 1 открывает свой исход
    marks.push(`${P}:1:0:roll=3`)
    expect(revealedBy(t, P, marks, `${P}:1:0:roll=3`).map((n) => n.text[0].t)).toEqual(['дракониды приставляют 1 лестницу и по ней взбираются 4 драконида'])
    // бой в исходе броска: победа открывает ветку «Если вы выходите из схватки победителем», висящую на корне
    const won = `${P}:1:0:r2:won`
    expect(revealedBy(t, P, [...marks, won], won).map((n) => n.label)).toEqual(['Если вы выходите из схватки победителем'])
    expect(revealedBy(t, P, marks, `${P}:1:fail`).map((n) => n.label)).toEqual(['Если лестница не откинута'])
  })

  it('без боя в параграфе ветка «если победите» — обычный выбор (как раньше)', () => {
    let found = 0
    for (const l of idx.data.locations) for (const p of l.paragraphs) {
      const t = paragraphTree(p)
      for (const n of allNodes(t)) {
        if (n.on !== 'win') continue
        found++
        expect(allNodes(t).some((x) => (x.hints?.monsters ?? []).some((m) => !idx.monsterById.get(m)?.special)), `${l.id} §${p.n}`).toBe(true)
      }
    }
    expect(found).toBeGreaterThan(20)
  })

  it('сессия отмечает итог проверки удачи и боя на этапе книги', () => {
    setRng(seededRng(3))
    const s = new GameSession(blankGame(), null)
    s.quickStart()
    const h = s.heroes[0]
    s.luckCheck(h.uid, 1, 'zolotoy-gorod:2:1')
    expect(s.state.claimed).toContain('zolotoy-gorod:2:1:ok')
    expect(() => s.luckCheck(h.uid, 5, 'zolotoy-gorod:999:0')).toThrow('Нет такого места')
    s.startEncounter([{ monsterId: 'drakonid', count: 1 }], undefined, 'zolotoy-gorod:2:1:0:r2')
    for (const m of s.state.combat!.monsters) m.dead = true
    checkEnd(s.state.combat!, s.heroes)
    s.endCombat()
    expect(s.state.claimed).toContain('zolotoy-gorod:2:1:0:r2:won')
    s.bookMark('zolotoy-gorod:2:1', 'open')
    s.bookMark('zolotoy-gorod:2:1', 'open')
    expect(s.state.claimed!.filter((k) => k === 'zolotoy-gorod:2:1:open')).toHaveLength(1)
    expect(() => s.bookMark('zolotoy-gorod:2:1', 'взять')).toThrow('Неверная отметка')
  })
})
