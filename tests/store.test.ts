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
  it('все рёбра ссылаются на узлы, из Золотого города достижим Замок Чёрного мага', async () => {
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

  it('новая партия, герои, покупки, сохранение в localStorage', async () => {
    const s = useGameStore()
    s.newGame()
    const w = (await s.addHero('Воин', 'warrior'))!
    s.addHero('Маг', 'mage')
    s.buyItem(w.uid, 'weapon', 'mech-korotkiy')
    expect(s.hero(w.uid).money).toBe(30)
    const json = s.exportSave()
    expect(json).toContain('Воин')
    s.importSave(json)
    expect(s.heroes).toHaveLength(2)
  })

  it('параграф: удача, монеты, бутылка, свиток, артефакт, ловушка', async () => {
    const s = useGameStore()
    s.newGame()
    const t = (await s.addHero('Вор', 'thief'))!
    const r = (await s.luckCheck(t.uid, 5))!
    expect(typeof r.ok).toBe('boolean')
    s.adjustMoney(t.uid, 100); expect(s.hero(t.uid).money).toBe(140)
    s.giveItem(t.uid, 'bottle', '5', 1, false)
    expect(s.hero(t.uid).inventory.find((e) => e.kind === 'bottle')?.identified).toBe(false)
    s.giveScroll(t.uid, 'mage', 3)
    const scroll = s.hero(t.uid).inventory.find((e) => e.kind === 'scroll')!
    expect(scroll.ref.startsWith('mage-')).toBe(true)
    const n = (await s.findArtifact(t.uid))!
    expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(18)
    expect(s.game!.artifactsFound).toEqual([n])
    expect(s.hero(t.uid).xp).toBe(500)
    s.trapFound(t.uid)
    expect(s.hero(t.uid).xp).toBe(900)
  })

  it('бой из хранилища: встреча, ход героев и монстров, завершение', async () => {
    const s = useGameStore()
    s.newGame()
    const w = (await s.addHero('Воин', 'warrior'))!
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

  it('финал: схватка с Чёрным магом заканчивается победой, короной и артефактом', async () => {
    const s = useGameStore()
    s.newGame()
    const w = (await s.addHero('Воин', 'warrior'))!
    // вне зала Чёрного мага схватки нет
    expect(await s.finalDuelAttack(w.uid)).toBeUndefined()
    expect(s.notice).toMatch(/замке/)
    s.game!.locationId = 'zamok-chernogo-maga'
    s.game!.visited['zamok-chernogo-maga'] = [13]
    let won = false
    for (let i = 0; i < 200 && !won; i++) {
      w.lives = w.maxLives; w.status = {}
      won = (await s.finalDuelAttack(w.uid))!
    }
    expect(won).toBe(true)
    expect(s.game!.victory?.heroName).toBe('Воин')
    expect(s.hero(w.uid).money).toBeGreaterThanOrEqual(1040)
    expect(s.hero(w.uid).inventory.some((e) => e.kind === 'artifact')).toBe(true)
    s.drinkFountain()
    expect(s.hero(w.uid).lives).toBe(w.maxLives)
    // второй победы (и второй короны) не бывает
    const money = s.hero(w.uid).money
    await s.finalDuelAttack(w.uid)
    expect(s.hero(w.uid).money).toBe(money)
  })

  it('спутник сражается в бою и уходит после оговорённого числа боёв', async () => {
    const s = useGameStore()
    s.newGame()
    const w = (await s.addHero('Воин', 'warrior'))!
    s.addCompanion('rytsar', 1)
    expect(s.game!.companions).toHaveLength(1)
    s.startEncounter([{ monsterId: 'kobold', count: 1 }])
    expect(s.combat!.allies).toHaveLength(1)
    expect(s.combat!.allies[0].companionUid).toBe(s.game!.companions[0].uid)
    s.toMelee()
    let guard = 0
    while (s.combat && !s.combat.finished && guard++ < 100) {
      if (s.combat.turn === 'heroes') s.skip(w.uid)
      else s.monstersAct()
    }
    s.endCombat()
    expect(s.game!.companions).toHaveLength(0)
    expect(s.game!.log.some((e) => /выполнил уговор|пал в бою/.test(e.text))).toBe(true)
  })

  it('быстрый старт: четыре героя, снаряжение надето и уложено в 40 монет', async () => {
    const s = useGameStore()
    s.quickStart()
    expect(s.heroes.map((h) => h.classId)).toEqual(['warrior', 'mage', 'priest', 'thief'])
    for (const h of s.heroes) {
      expect(h.money).toBeGreaterThanOrEqual(0)
      expect(Object.keys(h.equipment).length).toBeGreaterThan(0)
    }
    expect(s.heroes[0].equipment.body && s.heroes[0].equipment.shield && s.heroes[0].equipment.rightHand).toBeTruthy()
    expect(s.heroes[3].equipment.ranged).toBeTruthy()
    expect(s.heroes[3].inventory.find((e) => e.ref === 'strela')?.qty).toBe(10)
    expect(s.heroes[1].equipment.ranged).toBeTruthy()
  })
})
