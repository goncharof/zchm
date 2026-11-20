// Планы локаций: ручная разметка tools/plans/<id>.json → src/data/plans.json (граф помещений для движка).
//   pnpm data:plans                          собрать все размеченные планы
//   pnpm exec tsx tools/build_plans.ts --check <id> [<id>…]   только проверить разметку, ничего не записывая
//
// Формат tools/plans/<id>.json (координаты — пиксели картинки плана public/img/locations/<id>.jpg, 1087×1654):
//   {
//     "id": "zolotoy-gorod",
//     "entrances": [{ "to": 40, "via": "ворота", "heading": "N" }],   // куда попадает партия с карты мира и куда смотрит
//     "rooms": { "40": { "at": [398, 1262], "kind": "улица" }, … },   // каждый параграф локации: где стоит его номер и что это
//     "links": [
//       { "a": 40, "b": 34, "via": "дверь" },                         // проход в обе стороны; сторона считается по координатам
//       { "a": 40, "b": 29, "via": "проход" },                        // «проход» — открытый путь: подсказка назовёт место («улица»)
//       { "a": 34, "b": 2, "via": "лестница", "side": "U" },          // side — сторона от a, если координаты её не передают
//       { "a": 5, "b": 9, "via": "люк", "oneway": true }              // только из a в b
//     ],
//     "notes": "что на плане было неясно"
//   }
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Location, LocationPlan, PlanExit, PlanSide } from '../src/types'
import { COMPASS, opposite, reachable, sideBetween } from '../src/engine/plans'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'tools', 'plans')
const OUT = path.join(root, 'src', 'data', 'plans.json')
/** размер картинок планов: все страницы Книги Жизни обрезаны одинаково */
const W = 1087
const H = 1654
const SIDES: PlanSide[] = [...COMPASS, 'U', 'D']

interface RawPlan {
  id: string
  entrances: { to: number; via: string; heading: PlanSide }[]
  rooms: Record<string, { at: [number, number]; kind: string }>
  links: { a: number; b: number; via: string; side?: PlanSide; oneway?: boolean }[]
  notes?: string
}

const locations = JSON.parse(readFileSync(path.join(root, 'src', 'data', 'locations.json'), 'utf8')) as Location[]

/** Проверить разметку и собрать граф; ошибки — списком (пустой список — разметка годится) */
export function buildPlan(raw: RawPlan): { plan: LocationPlan; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const loc = locations.find((l) => l.id === raw.id)
  if (!loc) return { plan: { id: raw.id, entrances: [], rooms: [] }, errors: [`нет локации «${raw.id}»`], warnings }
  const want = new Set(loc.paragraphs.map((p) => p.n))
  const have = new Set(Object.keys(raw.rooms ?? {}).map(Number))
  const missing = [...want].filter((n) => !have.has(n))
  const extra = [...have].filter((n) => !want.has(n))
  if (missing.length) errors.push(`нет помещений: ${missing.join(', ')}`)
  if (extra.length) errors.push(`лишние помещения (таких параграфов нет): ${extra.join(', ')}`)
  for (const [n, r] of Object.entries(raw.rooms ?? {})) {
    if (!Array.isArray(r.at) || r.at.length !== 2 || r.at[0] < 0 || r.at[0] > W || r.at[1] < 0 || r.at[1] > H) errors.push(`помещение ${n}: координаты вне картинки ${W}×${H}`)
    if (!r.kind?.trim()) errors.push(`помещение ${n}: не указано, что это (kind)`)
  }
  const exits = new Map<number, PlanExit[]>([...have].map((n) => [n, []]))
  const seenLinks = new Set<string>()
  for (const [i, l] of (raw.links ?? []).entries()) {
    const where = `связь №${i + 1} (${l.a}–${l.b})`
    if (!have.has(l.a) || !have.has(l.b)) { errors.push(`${where}: нет такого помещения`); continue }
    if (l.a === l.b) { errors.push(`${where}: помещение связано само с собой`); continue }
    const key = [Math.min(l.a, l.b), Math.max(l.a, l.b), l.via].join('|')
    if (seenLinks.has(key)) errors.push(`${where}: повтор`)
    seenLinks.add(key)
    if (!l.via?.trim()) errors.push(`${where}: не указано, что это за проход (via)`)
    if (l.side && !SIDES.includes(l.side)) { errors.push(`${where}: сторона «${l.side}» — нужна одна из ${SIDES.join(', ')}`); continue }
    const [ax, ay] = raw.rooms[l.a].at
    const [bx, by] = raw.rooms[l.b].at
    const computed = sideBetween({ x: ax, y: ay }, { x: bx, y: by })
    const side = l.side ?? computed
    if (l.side && l.side !== 'U' && l.side !== 'D') {
      const turn = Math.abs(COMPASS.indexOf(l.side as (typeof COMPASS)[number]) - COMPASS.indexOf(computed))
      if (Math.min(turn, 8 - turn) >= 3) warnings.push(`${where}: указана сторона ${l.side}, а по координатам ${computed} — проверьте`)
    }
    exits.get(l.a)!.push({ to: l.b, side, via: l.via })
    if (!l.oneway) exits.get(l.b)!.push({ to: l.a, side: opposite(side), via: l.via })
  }
  if (!raw.entrances?.length) errors.push('не указан вход в локацию (entrances)')
  for (const e of raw.entrances ?? []) {
    if (!have.has(e.to)) errors.push(`вход ведёт в помещение ${e.to}, которого нет`)
    if (!SIDES.includes(e.heading) || e.heading === 'U' || e.heading === 'D') errors.push(`вход в ${e.to}: heading «${e.heading}» — нужна сторона света`)
    if (!e.via?.trim()) errors.push(`вход в ${e.to}: не указано, что это (via)`)
  }
  const round = (v: number) => Math.round(v * 10000) / 10000
  const plan: LocationPlan = {
    id: raw.id,
    entrances: raw.entrances ?? [],
    rooms: [...have].sort((a, b) => a - b).map((n) => ({ n, x: round(raw.rooms[n].at[0] / W), y: round(raw.rooms[n].at[1] / H), kind: raw.rooms[n].kind, exits: exits.get(n)! })),
  }
  if (!errors.length) {
    const ok = reachable(plan)
    const lost = [...have].filter((n) => !ok.has(n)).sort((a, b) => a - b)
    if (lost.length) errors.push(`от входа не дойти до помещений: ${lost.join(', ')}`)
    const deadEnds = plan.rooms.filter((r) => !r.exits.length).map((r) => r.n)
    if (deadEnds.length) errors.push(`помещения без выходов (из них не выйти): ${deadEnds.join(', ')}`)
  }
  return { plan, errors, warnings }
}

function main() {
  const args = process.argv.slice(2)
  const check = args[0] === '--check'
  const only = check ? args.slice(1) : []
  const files = readdirSync(SRC).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).filter((id) => !only.length || only.includes(id))
  for (const id of only) if (!files.includes(id)) { console.error(`нет файла tools/plans/${id}.json`); process.exit(1) }
  const plans: LocationPlan[] = []
  let bad = 0
  for (const id of files) {
    let raw: RawPlan
    try { raw = JSON.parse(readFileSync(path.join(SRC, `${id}.json`), 'utf8')) as RawPlan } catch (e) { console.error(`${id}: не JSON — ${(e as Error).message}`); bad++; continue }
    if (raw.id !== id) { console.error(`${id}: в файле id «${raw.id}»`); bad++; continue }
    const { plan, errors, warnings } = buildPlan(raw)
    for (const w of warnings) console.warn(`${id}: предупреждение — ${w}`)
    if (errors.length) { bad++; for (const e of errors) console.error(`${id}: ОШИБКА — ${e}`); continue }
    const links = plan.rooms.reduce((s, r) => s + r.exits.length, 0)
    console.log(`${id}: ${plan.rooms.length} помещений, ${links} выходов, входов ${plan.entrances.length} — годится`)
    plans.push(plan)
  }
  if (bad) process.exit(1)
  if (check) return
  // порядок — как у локаций в Книге Жизни
  plans.sort((a, b) => locations.findIndex((l) => l.id === a.id) - locations.findIndex((l) => l.id === b.id))
  writeFileSync(OUT, `${JSON.stringify(plans)}\n`)
  const without = locations.filter((l) => l.plan && !plans.some((p) => p.id === l.id)).map((l) => l.id)
  console.log(`записано: src/data/plans.json (${plans.length} планов)${without.length ? `; без разметки: ${without.join(', ')}` : ''}`)
}

if (existsSync(SRC) && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
