// ХАУСРУЛ: карта мира открывается постепенно — партия знает места, где была, и куда от них ведут дороги.
import { describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { knownNodes, neighbours, shortestRoute } from '@/engine/world'
import { GameSession, blankGame, migrate } from '@/game/session'

const W = world as unknown as WorldMap

describe('карта мира открывается постепенно', () => {
  it('в начале известны старт и соседние узлы, остальная карта скрыта', () => {
    const g = blankGame('zolotoy-gorod')
    const k = knownNodes(W, g)
    expect([...k.seen]).toEqual(['zolotoy-gorod'])
    expect([...k.known].sort()).toEqual(['zolotoy-gorod', ...neighbours(W, 'zolotoy-gorod').map((n) => n.id)].sort())
    expect(k.known.size).toBeLessThan(W.nodes.length)
  })

  it('переход открывает все узлы пути и их соседей', () => {
    const s = new GameSession(blankGame('zolotoy-gorod'), W)
    s.quickStart()
    const start = s.state.worldNodeId!
    // дальний узел: путь не короче двух участков
    const far = W.nodes.find((n) => (shortestRoute(W, start, n.id)?.nodes.length ?? 0) >= 3)!
    const route = shortestRoute(W, start, far.id)!
    s.travelTo(far.id)
    const k = knownNodes(W, s.state)
    for (const id of route.nodes) expect(k.seen.has(id)).toBe(true)
    for (const nb of neighbours(W, far.id)) expect(k.known.has(nb.id)).toBe(true)
  })

  it('старое сохранение: известны старт, место партии и локации с пройденными помещениями', () => {
    const g = blankGame('zolotoy-gorod')
    delete g.seenNodes
    const other = W.nodes.find((n) => n.locationId && n.id !== 'zolotoy-gorod' && n.locationId !== 'zamok-chernogo-maga')!
    g.visited[other.locationId!] = [1]
    const k = knownNodes(W, migrate(g))
    expect(k.seen.has('zolotoy-gorod')).toBe(true)
    expect(k.seen.has(other.id)).toBe(true)
  })

  it('смена стартовой точки сбрасывает разведанное', () => {
    const s = new GameSession(blankGame('zolotoy-gorod'), W)
    const alt = W.nodes.find((n) => n.locationId && n.id !== 'zolotoy-gorod' && n.locationId !== 'zamok-chernogo-maga')!
    s.setStart(alt.id)
    expect(s.state.seenNodes).toEqual([alt.id])
  })
})
