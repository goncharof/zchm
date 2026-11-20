/**
 * Планы локаций как графы помещений. ХАУСРУЛ владельца (docs/RULES.md, «Что видят игроки»): по локации идут из
 * помещения в соседнее, а не «телепортом» по номеру; партия видит только выходы из того места, где стоит, —
 * «впереди площадь, направо дверь, налево переулок». Вернуться можно в любое помещение, где партия уже была.
 * Чистые функции без состояния: ими пользуются сессия, экран локации, сценарный и ИИ-ведущий.
 */
import type { LocationPlan, PlanExit, PlanRoom, PlanSide } from '@/types'

/** Стороны по кругу, по часовой стрелке от севера */
export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
type Compass = (typeof COMPASS)[number]
const isCompass = (s: PlanSide): s is Compass => (COMPASS as readonly string[]).includes(s)

/** Куда относительно взгляда партии: F — вперёд, R — направо, B — назад, L — налево, U и D — лестница вверх и вниз */
export type Rel = 'F' | 'FR' | 'R' | 'BR' | 'B' | 'BL' | 'L' | 'FL' | 'U' | 'D'
const RELS: Rel[] = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL']
/** подпись кнопки: «Направо: дверь» */
export const REL_GO: Record<Rel, string> = { F: 'Вперёд', FR: 'Вперёд и направо', R: 'Направо', BR: 'Назад и направо', B: 'Назад', BL: 'Назад и налево', L: 'Налево', FL: 'Вперёд и налево', U: 'Наверх', D: 'Вниз' }
/** в описании: «впереди площадь, направо дверь» */
export const REL_SEE: Record<Rel, string> = { F: 'впереди', FR: 'впереди справа', R: 'направо', BR: 'позади справа', B: 'позади', BL: 'позади слева', L: 'налево', FL: 'впереди слева', U: 'наверх', D: 'вниз' }
/** порядок перечисления: сначала то, что перед партией */
const REL_ORDER: Rel[] = ['F', 'FR', 'FL', 'R', 'L', 'U', 'D', 'BR', 'BL', 'B']

export const opposite = (s: PlanSide): PlanSide => (s === 'U' ? 'D' : s === 'D' ? 'U' : COMPASS[(COMPASS.indexOf(s as Compass) + 4) % 8])

/** Сторона, в которой точка b лежит от точки a на плане (ось y направлена вниз листа) */
export function sideBetween(a: { x: number; y: number }, b: { x: number; y: number }, aspect = 1): Compass {
  // aspect — высота листа к ширине: доли ширины и высоты приводятся к одному масштабу
  const angle = (Math.atan2(b.x - a.x, -(b.y - a.y) * aspect) * 180) / Math.PI
  return COMPASS[((Math.round(angle / 45) % 8) + 8) % 8]
}

/** Куда смотрит выход относительно взгляда партии */
export function relative(heading: PlanSide | null | undefined, side: PlanSide): Rel {
  if (side === 'U' || side === 'D') return side
  const h = heading && isCompass(heading) ? heading : 'N'
  return RELS[(COMPASS.indexOf(side as Compass) - COMPASS.indexOf(h) + 8) % 8]
}

export const roomOf = (plan: LocationPlan, n: number | null | undefined): PlanRoom | undefined => (n == null ? undefined : plan.rooms.find((r) => r.n === n))

/** Выходы оттуда, где стоит партия: из помещения — его выходы, от входа в локацию — сами входы.
 *  Скрытые пути (провал, ловушка) сюда не входят: по ним партию ведёт только текст книги */
export function exitsFrom(plan: LocationPlan, room: number | null | undefined): PlanExit[] {
  if (room == null) return plan.entrances.map((e) => ({ to: e.to, side: e.heading, via: e.via }))
  return (roomOf(plan, room)?.exits ?? []).filter((e) => !e.hidden)
}

/** Место без параграфа — двор между зданиями, перекрёсток: у него отрицательный номер, и номером его не называют */
export const isYard = (n: number | null | undefined): boolean => n != null && n < 0

export interface ExitView {
  to: number
  rel: Rel
  /** что видно в ту сторону: «дверь», «площадь»; у двух одинаковых — «первая дверь», «вторая дверь» */
  what: string
  /** партия там уже была — можно назвать номер */
  known: boolean
}

const ORDINALS = ['первая', 'вторая', 'третья', 'четвёртая', 'пятая', 'шестая']
const ORDINALS_M = ['первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой']
const ORDINALS_N = ['первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое']
/** порядковое слово в роде существительного: «вторая дверь», «второй проход», «второе окно» */
function ordinal(i: number, noun: string): string {
  const word = noun.split(' ')[0]
  const list = /[ая]$|ь$/.test(word) && !/(путь|туннель|тоннель|люк|лаз|мост|коридор|проход|переулок|зал|двор|пролом)$/.test(word) ? ORDINALS : /[ое]$/.test(word) ? ORDINALS_N : ORDINALS_M
  return list[i] ?? `${i + 1}-й`
}

/** Что партия видит вокруг: выходы с относительной стороной и подписью. Открытый путь («проход») называется по месту,
 *  куда он ведёт, — «площадь», «улица»; дверь, ворота и лестница — сами собой. */
export function lookAround(plan: LocationPlan, room: number | null | undefined, heading: PlanSide | null | undefined, visited: readonly number[] = []): ExitView[] {
  const here = roomOf(plan, room)
  const views = exitsFrom(plan, room).map((e) => {
    const target = roomOf(plan, e.to)
    const what = e.via === 'проход' ? target?.kind || 'проход' : e.via
    // расстояние по плану — чтобы из двух одинаковых выходов «первым» был ближний
    const dist = here && target ? Math.hypot(target.x - here.x, target.y - here.y) : 0
    return { to: e.to, rel: relative(heading, e.side), what, known: visited.includes(e.to), dist }
  })
  views.sort((a, b) => REL_ORDER.indexOf(a.rel) - REL_ORDER.indexOf(b.rel) || a.dist - b.dist)
  // одинаковые подписи в одну сторону различаются порядком: «первая дверь направо», «вторая дверь направо»
  const groups = new Map<string, typeof views>()
  for (const v of views) groups.set(`${v.rel}|${v.what}`, [...(groups.get(`${v.rel}|${v.what}`) ?? []), v])
  for (const g of groups.values()) if (g.length > 1) g.forEach((v, i) => { v.what = `${ordinal(i, v.what)} ${v.what}` })
  return views.map(({ to, rel, what, known }) => ({ to, rel, what, known }))
}

/** Одной строкой для рассказа ведущего: «Впереди площадь, направо дверь, налево переулок и дверь.» */
export function describeExits(views: readonly ExitView[]): string {
  if (!views.length) return 'Выходов отсюда не видно.'
  const parts: string[] = []
  for (const rel of REL_ORDER) {
    const list = views.filter((v) => v.rel === rel).map((v) => (v.known && !isYard(v.to) ? `${v.what} (§ ${v.to})` : v.what))
    if (list.length) parts.push(`${REL_SEE[rel]} ${list.length > 1 ? `${list.slice(0, -1).join(', ')} и ${list.at(-1)}` : list[0]}`)
  }
  const text = parts.join(', ')
  return `${text[0].toUpperCase()}${text.slice(1)}.`
}

/** Почему партии нельзя в помещение n (null — можно): только в соседнее, в уже пройденное или куда отправляет книга */
export function whyBlocked(plan: LocationPlan, at: { room?: number | null; visited: readonly number[] }, n: number, bookTargets: readonly number[] = []): string | null {
  if (!roomOf(plan, n)) return null // помещения нет на плане — граф о нём ничего не знает, не мешаем
  if (at.room === n || at.visited.includes(n) || bookTargets.includes(n)) return null
  if (exitsFrom(plan, at.room).some((e) => e.to === n)) return null
  return at.room == null ? 'Партия ещё у входа в локацию: сначала войдите.' : isYard(at.room) ? 'Отсюда туда прохода нет.' : `Из помещения ${at.room} туда прохода нет.`
}

/** Куда партия смотрит после перехода: по стороне выхода, которым прошла; лестница, возврат и переход по книге взгляда не меняют,
 *  кроме возврата в помещение не по соседству — тогда по направлению между помещениями на плане */
export function headingAfter(plan: LocationPlan, from: number | null | undefined, to: number, heading: PlanSide | null | undefined): PlanSide | null {
  const exit = exitsFrom(plan, from).find((e) => e.to === to)
  if (exit) return isCompass(exit.side) ? exit.side : heading ?? null
  const a = roomOf(plan, from)
  const b = roomOf(plan, to)
  return a && b && a !== b ? sideBetween(a, b) : heading ?? null
}

/** Помещения, достижимые от входов (для проверки разметки: недостижимое помещение нельзя пройти) */
export function reachable(plan: LocationPlan): Set<number> {
  const seen = new Set<number>()
  const queue = plan.entrances.map((e) => e.to)
  while (queue.length) {
    const n = queue.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    for (const e of roomOf(plan, n)?.exits ?? []) queue.push(e.to)
  }
  return seen
}
