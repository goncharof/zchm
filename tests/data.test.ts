import { describe, expect, it } from 'vitest'
import { gameData, idx } from '@/data'
import { paragraphText } from '@/game/book'
import { allNodes } from '@/game/tree'
import overrides from '../tools/book_overrides.json'
import world from '@/data/world.json'
import type { ParagraphHints, WorldMap } from '@/types'

/** Целостность сгенерированных данных: ловит поломки скриптов tools/*.py */
describe('данные игры', () => {
  it('бестиарий: уникальные id, у бойцов есть уровень, защита и жизни', () => {
    const ids = gameData.bestiary.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(gameData.bestiary.length).toBe(97)
    for (const m of gameData.bestiary.filter((x) => !x.special)) {
      expect(m.level, m.name).toBeTypeOf('number')
      if (m.id !== 'lishaynik-pozhiratel') {
        expect(m.defense, m.name).toBeTypeOf('number')
        expect(m.lives, m.name).toBeTypeOf('number')
      }
      expect(Array.isArray(m.attacks) ? m.attacks.length : m.attacks, m.name).toSatisfy((a: unknown) => a === 6 || ['death', 'magic', 'none'].includes(a as string))
    }
  })

  it('классы: 13 уровней с растущим опытом и жизнями', () => {
    expect(gameData.classes).toHaveLength(5)
    for (const c of gameData.classes) {
      expect(c.levels.map((l) => l.level)).toEqual([...Array(13).keys()])
      for (let i = 1; i < 13; i++) {
        expect(c.levels[i].xp, c.id).toBeGreaterThan(c.levels[i - 1].xp)
        expect(c.levels[i].lives, c.id).toBeGreaterThan(c.levels[i - 1].lives)
      }
    }
  })

  it('заклинания: 37 жреца и 54 мага, у каждого есть стоимость или формула и эффект', () => {
    expect(gameData.spells.filter((s) => s.caster === 'priest')).toHaveLength(37)
    expect(gameData.spells.filter((s) => s.caster === 'mage')).toHaveLength(54)
    for (const s of gameData.spells) {
      expect(s.cost !== null || !!s.costFormula, s.id).toBe(true)
      expect(s.effect?.type, s.id).toBeTruthy()
    }
    expect(gameData.artifacts.map((a) => a.n)).toEqual([...Array(18).keys()].map((i) => i + 1))
  })

  it('Книга Жизни: 15 глав, номера растут, подсказки ссылаются на существующих монстров', () => {
    expect(gameData.locations).toHaveLength(15)
    const checkHints = (h: ParagraphHints | undefined, where: string) => {
      for (const m of h?.monsters ?? []) expect(idx.monsterById.has(m), `${where}: ${m}`).toBe(true)
      for (const [m, n] of Object.entries(h?.monsterCounts ?? {})) {
        expect(h?.monsters, where).toContain(m)
        expect(n, where).toBeGreaterThan(1)
      }
      for (const b of h?.bottles ?? []) expect(b >= 1 && b <= 6, where).toBe(true)
      for (const it of h?.items ?? []) expect((it.kind === 'weapon' ? idx.weaponById : it.kind === 'armor' ? idx.armorById : it.kind === 'scroll' ? idx.spellById : idx.itemById).has(it.id), `${where}: ${it.id}`).toBe(true)
    }
    for (const l of gameData.locations) {
      const ns = l.paragraphs.map((p) => p.n)
      expect(ns[0], l.id).toBe(1)
      for (let i = 1; i < ns.length; i++) expect(ns[i], l.id).toBeGreaterThan(ns[i - 1])
      for (const p of l.paragraphs) {
        // у размеченных параграфов полный текст не хранится, а собирается из сегментов или дерева
        if (p.segments || p.tree) expect(p.text, `${l.id} §${p.n}`).toBeUndefined()
        else expect(p.text?.length, `${l.id} §${p.n}`).toBeGreaterThan(10)
        if (p.tree) expect(p.segments, `${l.id} §${p.n}`).toBeUndefined()
        for (const n of p.tree ? allNodes(p.tree) : []) checkHints(n.hints, `${l.id} §${p.n} ${n.id}`)
        expect(paragraphText(p).length, `${l.id} §${p.n}`).toBeGreaterThan(10)
        checkHints(p.hints, `${l.id} §${p.n}`)
        for (const seg of p.segments ?? []) {
          expect(['scene', 'branch']).toContain(seg.kind)
          if (seg.kind === 'branch') expect(seg.label, `${l.id} §${p.n}`).toBeTruthy()
          checkHints(seg.hints, `${l.id} §${p.n}`)
          for (const b of seg.blocks) {
            if ('roll' in b) for (const o of b.roll) for (const v of o.values) expect(v >= 1 && v <= 18, `${l.id} §${p.n}`).toBe(true)
          }
        }
      }
    }
  })

  it('карта: узлы локаций ссылаются на главы, граф связен', () => {
    const w = world as unknown as WorldMap
    for (const n of w.nodes) if (n.locationId) expect(idx.locationById.has(n.locationId), n.id).toBe(true)
    const adj = new Map<string, string[]>()
    for (const e of w.edges) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
    }
    const seen = new Set([w.nodes[0].id])
    const queue = [w.nodes[0].id]
    while (queue.length) for (const nb of adj.get(queue.shift()!) ?? []) if (!seen.has(nb)) { seen.add(nb); queue.push(nb) }
    expect(seen.size).toBe(w.nodes.length)
  })

  it('ручные правки разметки применены и не устарели (tools/book_overrides.json)', () => {
    type Ov = { hints?: Record<string, Record<string, unknown>>; when?: Record<string, string | null>; split?: Record<string, { label: string; text: string }[]> }
    for (const [key, ov] of Object.entries(overrides as Record<string, Ov | string>)) {
      if (key.startsWith('_') || typeof ov === 'string') continue
      const [locId, n] = key.split(':')
      const p = idx.locationById.get(locId)?.paragraphs.find((x) => x.n === Number(n))
      expect(p, key).toBeDefined()
      // одинаковые условия веток различаются номером: «Если пьете#2»
      const branch = (name: string) => {
        const m = /^(.*)#(\d+)$/.exec(name)
        return p!.segments?.filter((g) => g.kind === 'branch' && g.label === (m ? m[1] : name))[m ? Number(m[2]) - 1 : 0]
      }
      const target = (name: string) => name === 'paragraph' ? p : name === 'scene' ? p!.segments?.find((g) => g.kind === 'scene') : branch(name)
      for (const [name, fields] of Object.entries(ov.hints ?? {})) {
        const t = target(name)
        expect(t, `${key} «${name}»`).toBeDefined()
        for (const [k, v] of Object.entries(fields)) {
          const got = (t!.hints as Record<string, unknown> | undefined)?.[k]
          if (v === null || (Array.isArray(v) && !v.length)) expect(got, `${key} «${name}» ${k}`).toBeUndefined()
          else expect(got, `${key} «${name}» ${k}`).toEqual(v)
        }
      }
      // разрезанная ветка: каждый кусок стал веткой со своим условием и дословным текстом
      for (const [name, pieces] of Object.entries(ov.split ?? {})) {
        for (const piece of pieces) {
          // одинаковые условия возможны («Прямо» в двух развилках) — кусок должен найтись в одной из таких веток
          const label = piece.label[0].toUpperCase() + piece.label.slice(1)
          const same = p!.segments?.filter((g) => g.kind === 'branch' && g.label === label) ?? []
          const texts = same.map((g) => g.blocks.map((b) => ('text' in b ? b.text : '')).join(' ').toLowerCase())
          expect(texts.some((t) => t.includes(piece.text.slice(1, 40).toLowerCase())), `${key} разрезание «${name}»: нет ветки «${piece.label}» с этим текстом`).toBe(true)
        }
      }
      for (const [name, when] of Object.entries(ov.when ?? {})) {
        const t = branch(name)
        expect(t, `${key} «${name}»`).toBeDefined()
        expect(t!.when, `${key} «${name}»`).toBe(when ?? undefined)
      }
    }
  })
})
