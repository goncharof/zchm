// Дерево этапов параграфа (src/game/tree.ts): старая разметка → дерево без потерь, открытие этапов по отметкам.
import { describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { paragraphText, treeText } from '@/game/book'
import { allNodes, nodeText, openChoices, openNodes, paragraphTree, revealedBy } from '@/game/tree'
import { GameSession, blankGame } from '@/game/session'
import { readFileSync, readdirSync } from 'node:fs'
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

  it('ручная разметка в данных совпадает с tools/book (данные пересобраны после правки)', () => {
    const dir = new URL('../tools/book/', import.meta.url)
    let trees = 0
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const file = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Record<string, unknown>
      for (const [n, tree] of Object.entries(file)) {
        if (n.startsWith('_')) continue
        expect(para(f.replace('.json', ''), Number(n)).tree, `${f} § ${n}`).toEqual(tree)
        trees++
      }
    }
    expect(trees).toBeGreaterThan(20)
  })

  it('тайная пометка из середины фразы вырезается, соседние куски склеиваются с точкой', () => {
    const root = paragraphTree(para('krepost-rytsarey', 44))
    expect(nodeText(root)).toContain('сидит раненый берсеркер. Кровь течет')
    expect(nodeText(root)).not.toContain('5 жизней')
  })

  it('старая разметка, Упокоище § 26: исходы удачи закрыты до проверки, вариант — по выбору', () => {
    const t = paragraphTree(para('upokoische', 26))
    const P = 'upokoische:26'
    const open = openNodes(t, P).map((n) => n.id)
    expect(open[0]).toBe('0')
    expect(allNodes(t).some((n) => n.on === 'fail')).toBe(true)
    expect(open.some((id) => allNodes(t).find((n) => n.id === id)!.on === 'fail')).toBe(false)
  })

  it('Золотой город § 2 (ручное дерево): помощь по выбору, бросок открывает свою лестницу, провал удачи — бой, победа — награда', () => {
    const t = paragraphTree(para('zolotoy-gorod', 2))
    const P = 'zolotoy-gorod:2'
    expect(openNodes(t, P).map((n) => n.id)).toEqual(['a'])
    expect(openChoices(t, P).map((n) => n.label)).toEqual(['Если вы решили помочь стражникам, бросьте кубик'])
    const marks = [`${P}:b:open`]
    expect(openNodes(t, P, marks).map((n) => n.id)).toEqual(['a', 'b'])
    marks.push(`${P}:b:roll=3`)
    expect(revealedBy(t, P, marks, `${P}:b:roll=3`).map((n) => n.text[0].t)).toEqual(['дракониды приставляют 1 лестницу и по ней взбираются 4 драконида'])
    const fail = `${P}:r3:fail`
    const fight = revealedBy(t, P, [...marks, fail], fail)
    expect(fight.map((n) => n.hints?.monsterCounts)).toEqual([{ drakonid: 4 }])
    const won = `${P}:f3:won`
    expect(revealedBy(t, P, [...marks, fail, won], won).map((n) => n.hints?.bottles)).toEqual([[5, 5]])
    // удача — лестницу откинули: ни боя, ни награды
    expect(revealedBy(t, P, marks, `${P}:r3:ok`)).toEqual([])
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

  it('последствия этапа берутся из книги и применяются один раз: святая вода лечит каждого на 1к6', () => {
    setRng(seededRng(7))
    const s = new GameSession(blankGame(), null)
    s.quickStart()
    for (const h of s.heroes) s.adjustLives(h.uid, -6)
    const before = s.heroes.map((h) => h.lives)
    const lines = s.bookEffects('zolotoy-gorod:17:b')
    expect(lines).toHaveLength(s.heroes.length)
    s.heroes.forEach((h, i) => expect(h.lives).toBeGreaterThan(before[i]))
    expect(() => s.bookEffects('zolotoy-gorod:17:b')).toThrow('уже применены')
    expect(() => s.bookEffects('zolotoy-gorod:17:a')).toThrow('нет последствий')
    // «У вас 1 жизнь» и «ничего нет, кроме денег и артефакта» (Крепость рыцарей, 23)
    s.bookEffects('krepost-rytsarey:23:h')
    expect(s.heroes.every((x) => x.lives === 1)).toBe(true)
    s.giveItem(s.heroes[0].uid, 'artifact', '1')
    const coins = s.heroes[0].money
    s.bookEffects('krepost-rytsarey:23:g')
    expect(s.heroes[0].inventory.map((e) => e.kind)).toEqual(['artifact'])
    expect(s.heroes[0].money).toBe(coins)
    expect(Object.keys(s.heroes[0].equipment)).toEqual([])
    // обед: −2 монеты и +1 жизнь тому, кто действует
    const h = s.heroes[1]
    const money = h.money
    s.bookEffects('zolotoy-gorod:19:b', h.uid)
    expect(h.money).toBe(money - 2)
  })
})
