/** Карта мира: кратчайший путь по дорогам, дни пути, случайные встречи. */
import type { WorldMap } from '@/types'
import { k6, roll } from './dice'

/** Дни пути по ребру: клетки (кресты) между узлами + 1 */
export function edgeDays(cells: number): number {
  return cells + 1
}

export interface Route {
  nodes: string[]
  days: number
}

/** Дейкстра по дням пути */
export function shortestRoute(world: WorldMap, from: string, to: string): Route | null {
  if (from === to) return { nodes: [from], days: 0 }
  const dist = new Map<string, number>()
  const prev = new Map<string, string>()
  const todo = new Set(world.nodes.map((n) => n.id))
  for (const id of todo) dist.set(id, Infinity)
  dist.set(from, 0)
  while (todo.size) {
    let cur: string | null = null
    let best = Infinity
    for (const id of todo) {
      const d = dist.get(id) ?? Infinity
      if (d < best) { best = d; cur = id }
    }
    if (cur === null || best === Infinity) break
    todo.delete(cur)
    if (cur === to) break
    for (const e of world.edges) {
      const other = e.from === cur ? e.to : e.to === cur ? e.from : null
      if (!other || !todo.has(other)) continue
      const nd = best + edgeDays(e.cells)
      if (nd < (dist.get(other) ?? Infinity)) { dist.set(other, nd); prev.set(other, cur) }
    }
  }
  if ((dist.get(to) ?? Infinity) === Infinity) return null
  const nodes = [to]
  while (nodes[0] !== from) nodes.unshift(prev.get(nodes[0])!)
  return { nodes, days: dist.get(to)! }
}

export function neighbours(world: WorldMap, nodeId: string): { id: string; cells: number }[] {
  return world.edges
    .filter((e) => e.from === nodeId || e.to === nodeId)
    .map((e) => ({ id: e.from === nodeId ? e.to : e.from, cells: e.cells }))
}

/** Что партия знает о карте мира. ХАУСРУЛ: карта открывается постепенно — видны места, где партия была (seen), и
 *  соседние узлы, куда от них ведут дороги (known = seen + соседи); остальное скрыто туманом. Локация с пройденными
 *  помещениями считается посещённой и в старых сохранениях, где пути партии ещё не записывались. */
export function knownNodes(world: WorldMap, state: { seenNodes?: string[]; worldNodeId: string | null; startNodeId?: string | null; visited?: Record<string, number[]> }): { seen: Set<string>; known: Set<string> } {
  const seen = new Set<string>(state.seenNodes ?? [])
  if (state.worldNodeId) seen.add(state.worldNodeId)
  if (state.startNodeId) seen.add(state.startNodeId)
  for (const n of world.nodes) if (n.locationId && (state.visited?.[n.locationId]?.length ?? 0) > 0) seen.add(n.id)
  const known = new Set(seen)
  for (const id of seen) for (const nb of neighbours(world, id)) known.add(nb.id)
  return { seen, known }
}

/** ХАУСРУЛ: за каждый день пути к6, на 1–2 — случайная встреча из главы «Дорога» */
export function rollRoadEncounters(days: number, roadParagraphNumbers: number[]): number[] {
  const out: number[] = []
  for (let d = 0; d < days; d++) {
    if (k6() <= 2 && roadParagraphNumbers.length) out.push(roadParagraphNumbers[roll(roadParagraphNumbers.length) - 1])
  }
  return out
}

/** Локации с лавкой и трактиром (ХАУСРУЛ: города и крепости) */
export const SERVICES: Record<string, ('shop' | 'tavern')[]> = {
  'zolotoy-gorod': ['shop', 'tavern'],
  'krepost-rytsarey': ['shop', 'tavern'],
  'zamok-zhretsov': ['shop', 'tavern'],
  'mertvyy-gorod': ['tavern'],
  'krepost-korolya-nazgulov': ['tavern'],
  'krepost-posledney-nadezhdy': ['shop', 'tavern'],
  'broshennyy-gorod': ['shop', 'tavern'],
  'severnyy-fort': ['shop', 'tavern'],
}
