import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { seededRng, setRng } from '@/engine/dice'
import { shortestRoute } from '@/engine/world'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'

// localStorage для node-окружения
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage

const { useGameStore } = await import('@/stores/game')

describe('карта мира', () => {
  const w = world as unknown as WorldMap
  it('все рёбра ссылаются на узлы, из Золотого города достижим Замок Чёрного мага', () => {
    const ids = new Set(w.nodes.map((n) => n.id))
    for (const e of w.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true) }
    const r = shortestRoute(w, 'zolotoy-gorod', 'zamok-chernogo-maga')
    expect(r).not.toBeNull()
    expect(r!.days).toBeGreaterThan(3)
    expect(r!.nodes[0]).toBe('zolotoy-gorod')
    expect(r!.nodes[r!.nodes.length - 1]).toBe('zamok-chernogo-maga')
  })
})

describe('хранилище партии', () => {
  beforeEach(() => { setActivePinia(createPinia()); mem.clear(); setRng(seededRng(11)) })

  it('новая партия, герои, покупки, сохранение в localStorage', () => {
    const s = useGameStore()
    s.newGame()
    const w = s.addHero('Воин', 'warrior')
    s.addHero('Маг', 'mage')
    s.buyItem(w.uid, 'weapon', 'mech-korotkiy')
    expect(s.hero(w.uid).money).toBe(30)
    expect(mem.get('zchm.save.v1')).toBeUndefined() // watch сработает после flush
    const json = s.exportSave()
    expect(json).toContain('Воин')
    s.importSave(json)
    expect(s.heroes).toHaveLength(2)
  })

  it('параграф: удача, монеты, бутылка, свиток, артефакт, ловушка', () => {
    const s = useGameStore()
    s.newGame()
    const t = s.addHero('Вор', 'thief')
    const r = s.luckCheck(t.uid, 5)
    expect(typeof r.ok).toBe('boolean')
    s.adjustMoney(t.uid, 100); expect(s.hero(t.uid).money).toBe(140)
    s.giveItem(t.uid, 'bottle', '5', 1, false)
    expect(s.hero(t.uid).inventory.find((e) => e.kind === 'bottle')?.identified).toBe(false)
    s.giveScroll(t.uid, 'mage', 3)
    const scroll = s.hero(t.uid).inventory.find((e) => e.kind === 'scroll')!
    expect(scroll.ref.startsWith('mage-')).toBe(true)
    const n = s.findArtifact(t.uid)
    expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(18)
    expect(s.game!.artifactsFound).toEqual([n])
    expect(s.hero(t.uid).xp).toBe(500)
    s.trapFound(t.uid)
    expect(s.hero(t.uid).xp).toBe(900)
  })

  it('бой из хранилища: встреча, ход героев и монстров, завершение', () => {
    const s = useGameStore()
    s.newGame()
    const w = s.addHero('Воин', 'warrior')
    s.adjustMoney(w.uid, 500)
    s.buyItem(w.uid, 'weapon', 'mech-dvuruchnyy')
    s.equipItem(w.uid, s.hero(w.uid).inventory[0].uid)
    s.startEncounter([{ monsterId: 'kobold', count: 2 }], '/location/zolotoy-gorod')
    expect(s.combat).not.toBeNull()
    s.toMelee()
    let guard = 0
    while (s.combat && !s.combat.finished && guard++ < 300) {
      if (s.combat.turn === 'heroes') {
        const m = s.combat.monsters.find((x) => !x.dead && !x.fled)!
        s.attack(w.uid, 'rightHand', m.uid)
      } else s.monstersAct()
    }
    expect(s.combat!.finished).toBeDefined()
    s.endCombat()
    expect(s.combat).toBeNull()
    expect(s.game!.log.some((e) => /Опыт за бой/.test(e.text))).toBe(true)
  })

  it('путешествие по карте меняет день и узел', async () => {
    const s = useGameStore()
    s.newGame()
    s.addHero('Жрец', 'priest')
    s.world = world as unknown as WorldMap
    s.travelTo('severnyy-fort')
    expect(s.game!.worldNodeId).toBe('severnyy-fort')
    expect(s.game!.day).toBeGreaterThan(1)
    s.enterLocation('severnyy-fort')
    expect(s.location?.name).toBe('Северный форт')
  })
})
