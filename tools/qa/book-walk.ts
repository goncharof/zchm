/**
 * Обход Книги Жизни ботом (docs/PROGRESS.md, «проверить разметку игрой»). Каждый параграф проигрывается всеми путями,
 * которые дают кнопки: варианты выбора, бой (победа, поражение, бегство), проверка удачи (удача, неудача), отмычки,
 * бросок по списку (каждая грань), отметки других помещений. Ошибки разметки:
 * - этап, который не открывается ни в одной игре (его текст игроки не увидят);
 * - вариант без подписи, исход броска вне кубика или без списка у родителя, список без исходов;
 * - ссылки на несуществующие помещения, монстров, вещи; условие по отметке, которую никто не ставит.
 * Предупреждения: грань кубика ничего не открывает, проверка удачи ни на что не влияет, обход оборван по пределу.
 * Для ручной проверки (эвристики по тексту этапа): удача, кубик, бутылки, монеты, смерть, жизни, опыт в тексте без
 * механики у этапа; исход «если победите / не повезёт» в тексте этапа, который виден до боя или проверки.
 *
 * Запуск: pnpm exec tsx tools/qa/book-walk.ts [локация ...]  → отчёт в tools/qa/out/book-walk.md
 * Тест tests/book-walk.test.ts требует, чтобы ошибок не было.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { idx } from '@/data'
import world from '@/data/world.json'
import type { BookNode, WorldMap } from '@/types'
import { allNodes, canFightHints, diceKey, findNode, nodeFullText, openNodes, paragraphTree, parentOf, rollOf } from '@/game/tree'
import { blankGame } from '@/game/session'
import { checkEnd } from '@/engine/combat'
import { seededRng, setRng } from '@/engine/dice'
import { Room } from '../../server/rooms'
import { ScriptedGm, luckPenalty } from '../../server/gm/script'
import type { GmContext } from '../../server/gm/types'

export type Level = 'error' | 'warn' | 'check'
export interface Finding {
  loc: string
  n: number
  /** этап дерева */
  id?: string
  level: Level
  what: string
  /** параграф размечен вручную (tools/book) */
  hand: boolean
}

/** Предел состояний обхода одного параграфа; дальше — грубая оценка (все отметки сразу) */
const MAX_STATES = 30000

/** Ход игры: отметка и этап, на котором она ставится (у варианта выбора — сам вариант; у отметки другого помещения — '') */
interface Move { m: string; at: string }

/** Ходы, доступные в этом состоянии параграфа: каждый — отдельный путь игры. loose — без ограничений «один вариант из
 *  exclusive» и «список бросают один раз» (для грубой оценки) */
function moves(tree: BookNode, P: string, claimed: readonly string[], external: readonly string[], loose = false): Move[] {
  const set = new Set(claimed)
  const has = (id: string, w: string) => set.has(`${P}:${id}:${w}`)
  const open = openNodes(tree, P, claimed)
  const ids = new Set(open.map((n) => n.id))
  const out: Move[] = []
  const add = (m: string, at: string) => { if (!set.has(m)) out.push({ m, at }) }
  for (const n of open) {
    const h = n.hints
    // бой с кнопки этапа: проигранный или брошенный бой можно начать снова, выигранный — нет
    if (canFightHints(h) && !has(n.id, 'won')) for (const w of ['won', 'lost', 'fled']) add(`${P}:${n.id}:${w}`, n.id)
    // проверку удачи после неудачи можно повторить (кнопка остаётся), после удачи — нет
    if ((h?.luck?.length || n.passWith) && !has(n.id, 'ok')) {
      add(`${P}:${n.id}:ok`, n.id)
      if (h?.luck?.length) add(`${P}:${n.id}:fail`, n.id)
    }
    if (n.action === 'final-duel') add(`${P}:${n.id}:won`, n.id)
    const d = n.dice
    if (d && !d.repeat && (loose || !claimed.some((k) => k.startsWith(`${P}:${diceKey(n)}:roll=`)))) {
      for (let r = 1; r <= d.sides; r++) add(`${P}:${diceKey(n)}:roll=${r}`, n.id)
    }
    const kids = (n.then ?? []).filter((c) => c.on === 'choice')
    if (loose || !(n.exclusive && kids.some((c) => ids.has(c.id)))) for (const c of kids) if (!ids.has(c.id)) add(`${P}:${c.id}:open`, c.id)
  }
  for (const m of external) add(m, '')
  return out
}

interface Explored {
  /** этапы, открытые хотя бы в одной игре */
  opened: Set<string>
  /** отметки, поставленные хотя бы в одной игре */
  marks: Set<string>
  /** отметка → открыла ли она что-нибудь хотя бы раз (нет ключа — ход не встретился) */
  fruitful: Map<string, boolean>
  /** состояний слишком много даже для поиска отдельного этапа */
  truncated: boolean
}

/** Игры параграфа обходом в ширину по наборам отметок. only — ходы только на этих этапах; until — остановиться, когда
 *  этот этап открылся */
function search(tree: BookNode, P: string, external: readonly string[], only?: Set<string>, until?: string): Explored {
  const opened = new Set<string>(), marks = new Set<string>(), fruitful = new Map<string, boolean>()
  const seen = new Set<string>([''])
  const queue: string[][] = [[]]
  let truncated = false
  while (queue.length && !truncated) {
    const st = queue.shift()!
    const now = openNodes(tree, P, st)
    for (const n of now) opened.add(n.id)
    if (until && opened.has(until)) break
    for (const { m, at } of moves(tree, P, st, external)) {
      if (only && at && !only.has(at)) continue
      const next = [...st, m].sort()
      marks.add(m)
      const grew = openNodes(tree, P, next).length > now.length
      fruitful.set(m, grew || !!fruitful.get(m))
      const key = next.join('|')
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > MAX_STATES) { truncated = true; break }
      queue.push(next)
    }
  }
  return { opened, marks, fruitful, truncated }
}

/** Этапы, от которых зависит, откроется ли target: его предки, а у исходов боя и удачи — всё поддерево родителя (итог
 *  ищется там, src/game/tree.ts, openNodes) */
function relevant(tree: BookNode, target: string): Set<string> {
  const rel = new Set<string>()
  for (let cur = findNode(tree, target); cur; cur = parentOf(tree, cur.id)) {
    rel.add(cur.id)
    const par = parentOf(tree, cur.id)
    if (par && typeof cur.on === 'string' && RESULTS.has(cur.on)) for (const x of allNodes(par)) rel.add(x.id)
  }
  return rel
}
const RESULTS = new Set(['win', 'lose', 'flee', 'ok', 'fail'])

/** Все игры параграфа. Если состояний слишком много (независимые ветки), каждый не открытый этап ищется отдельно —
 *  ходами только на тех этапах, от которых он зависит; отметки — грубой оценкой (все сразу) */
export function explore(tree: BookNode, P: string, external: readonly string[]): Explored {
  const e = search(tree, P, external)
  if (!e.truncated) return e
  let rough = false
  for (const n of allNodes(tree)) {
    if (e.opened.has(n.id)) continue
    const t = search(tree, P, external, relevant(tree, n.id), n.id)
    if (t.opened.has(n.id)) e.opened.add(n.id)
    else if (t.truncated) rough = true
    for (const [m, f] of t.fruitful) e.fruitful.set(m, f || !!e.fruitful.get(m))
  }
  let st: string[] = []
  for (;;) {
    const add = moves(tree, P, st, external, true).map((x) => x.m)
    if (!add.length) break
    for (const m of add) e.marks.add(m)
    st = [...st, ...add]
  }
  return { ...e, truncated: rough }
}

/** Исход броска «на каждый»: такие этапы не открываются, а показываются при выпадении (их дети не откроются никогда) */
const repeatOption = (tree: BookNode, n: BookNode) => !!rollOf(n) && !!parentOf(tree, n.id)?.dice?.repeat

const MONSTER = (id: string) => idx.monsterById.has(id)
const ITEM: Record<string, (id: string) => boolean> = {
  weapon: (id) => idx.weaponById.has(id), armor: (id) => idx.armorById.has(id), item: (id) => idx.itemById.has(id), scroll: (id) => idx.spellById.has(id),
}

/** Целостность дерева: подписи, кубики, ссылки */
export function integrity(tree: BookNode, locId: string, push: (f: Omit<Finding, 'loc' | 'n' | 'hand'>) => void): void {
  const loc = idx.locationById.get(locId)!
  for (const n of allNodes(tree)) {
    const err = (what: string) => push({ id: n.id, level: 'error', what })
    if (n.on === 'choice' && !n.label?.trim()) err('вариант выбора без подписи (кнопка будет пустой)')
    const roll = rollOf(n)
    if (roll) {
      const d = parentOf(tree, n.id)?.dice
      if (!d) err('исход броска, а у родителя нет списка (dice)')
      else if (roll.some((r) => r < 1 || r > d.sides)) err(`исход броска ${roll.join(', ')} не выпадает на к${d.sides}`)
    }
    if (n.dice) {
      const opts = (n.then ?? []).filter((c) => rollOf(c))
      if (!opts.length) err('список броска без исходов')
      const faces = new Map<number, string[]>()
      for (const c of opts) for (const r of rollOf(c)!) faces.set(r, [...(faces.get(r) ?? []), c.id])
      for (const [r, who] of faces) if (who.length > 1) push({ id: n.id, level: 'warn', what: `грань ${r} открывает сразу несколько исходов: ${who.join(', ')}` })
    }
    if (n.goto !== undefined && !loc.paragraphs.some((x) => x.n === n.goto)) err(`переход в помещение ${n.goto}, которого нет в «${loc.name}»`)
    if (n.passWith && !idx.itemById.has(n.passWith)) err(`passWith: нет вещи «${n.passWith}»`)
    for (const m of n.hints?.monsters ?? []) if (!MONSTER(m)) err(`нет монстра «${m}»`)
    for (const m of n.npcs ?? []) if (/^[a-z0-9-]+$/.test(m) && !MONSTER(m)) err(`npcs: нет монстра «${m}»`)
    for (const it of n.hints?.items ?? []) if (!ITEM[it.kind]?.(it.id)) err(`нет вещи ${it.kind} «${it.id}»`)
    for (const e of n.effects ?? []) if ('companion' in e && !MONSTER(e.companion)) err(`спутник: нет монстра «${e.companion}»`)
    if (repeatOption(tree, n) && n.then?.length) err('у исхода броска «на каждый» есть этапы-дети — они не откроются')
  }
}

/** Эвристики по тексту этапа: механика, о которой говорит текст, а у этапа, его родителя и поддерева её нет (награда
 *  обычно лежит в исходе победы, плата — в последствиях варианта) */
function textChecks(tree: BookNode, hand: boolean, push: (f: Omit<Finding, 'loc' | 'n' | 'hand'>) => void): void {
  for (const n of allNodes(tree)) {
    const own = [n.label ?? '', nodeFullText(n)].join(' ')
    const t = own.toLowerCase().replace(/ё/g, 'е')
    const near = [parentOf(tree, n.id), ...allNodes(n)].filter((x): x is BookNode => !!x)
    const hints = near.map((x) => x.hints ?? {})
    const fx = near.flatMap((x) => x.effects ?? [])
    const check = (what: string) => push({ id: n.id, level: 'check', what: `${what}: «${excerpt(own, what)}»` })
    if (/удач\S*\s*[—–-]?\s*\d+/.test(t) && !near.some((x) => x.hints?.luck?.length || x.passWith || x.action === 'final-duel')) check('удача в тексте, кнопки проверки нет')
    if (/брос\S*\s+(?:\S+\s+)?(?:кубик|кост)/.test(t) && !near.some((x) => x.dice || x.hints?.luck?.length)) check('бросок кубика в тексте, списка нет')
    if (/\([1-8]\)/.test(own) && !hints.some((h) => h.bottles?.length)) check('бутылка в тексте, а в подсказках этапа и его исходов её нет')
    const sums = hints.flatMap((h) => [...(h.coins ?? []), ...(h.prices ?? [])])
    for (const e of fx) if ('coins' in e && typeof e.coins === 'number') sums.push(Math.abs(e.coins))
    for (const m of t.matchAll(/(\d+)\s+(?:золот\S+\s+)?монет/g)) {
      if (!sums.includes(Number(m[1]))) { check(`${m[1]} монет в тексте, а в подсказках и последствиях этапа и его исходов их нет`); break }
    }
    const lives = fx.filter((e) => 'lives' in e)
    // смерть героев, а не встречных («гном… умирает»)
    const death = /(?:погибаете|умираете|верная смерть|иначе\s*[—–-]?\s*смерть|вы мертвы)/.test(t)
    // старая разметка: смерть и урон при провале удачи сценарный ведущий берёт из текста (luckPenalty)
    const penalty = !hand && hints.some((h) => (h.luck ?? []).some((x) => luckPenalty(own, x)))
    if (death && !lives.some((e) => 'lives' in e && e.lives === 'death') && !penalty) check('смерть в тексте, последствия «смерть» нет')
    if (/(?:теря\S*|отнима\S*|лиша\S*|отнимет\S*)\s+[^.]{0,30}?(?:\d+|1к\d+)\s+жизн|[-−–]\s?\d+\s+жизн/.test(t) && !lives.length && !penalty) check('потеря жизней в тексте, последствия нет')
    if (/\d+\s+(?:очк\S+\s+)?опыт/.test(t) && !fx.some((e) => 'xp' in e)) check('опыт в тексте, последствия нет')
    if ((n.on === 'enter' || n.on === 'choice') && SPOILER.test(t)) check('исход боя или проверки в тексте этапа, который виден сразу')
  }
}

const SPOILER = /если\s+(?:же\s+)?(?:вы\s+)?(?:его|их|ее|эту тварь)?\s*(?:победите|победили|убьете|убили|одолеете|проиграете)|(?:в случае|при)\s+(?:победы|поражения|неудач\S*)|если\s+(?:вам\s+)?(?:не\s+)?(?:повезет|повезло|удалось|удастся)|если\s+(?:вы\s+)?(?:не\s+)?(?:выкинете|выбросите)|если выпал/

/** Кусок текста вокруг найденного (до 140 знаков) */
function excerpt(text: string, what: string): string {
  const key = /удач/.test(what) ? /удач/i : /кубик/.test(what) ? /брос/i : /бутыл/.test(what) ? /\([1-8]\)/ : /монет/.test(what) ? /монет/i
    : /смерть/.test(what) ? /погиба|умира|смерть|мертв/i : /жизн/.test(what) ? /жизн/i : /опыт/.test(what) ? /опыт/i : SPOILER
  const i = Math.max(0, text.toLowerCase().replace(/ё/g, 'е').search(key))
  const s = Math.max(0, i - 70)
  return `${s ? '…' : ''}${text.slice(s, s + 140).replace(/\s+/g, ' ').trim()}${s + 140 < text.length ? '…' : ''}`
}

/** Предупреждения, разобранные при разметке (docs/DECISIONS.md): место → причина */
const KNOWN: Record<string, string> = {
  'zolotoy-gorod:7:b:luck': 'последствие паралича книга не задаёт (DECISIONS, «Ручная разметка: Золотой город»)',
  'zamok-chernogo-maga:4:a:luck': 'молния тени: штраф книга не задаёт (DECISIONS, «Ручная разметка: Замок Чёрного мага»)',
}
const known = (P: string, id: string, what: string) => `${P}:${id}:${what}` in KNOWN

/** Обход всей книги (или названных глав) */
export function walkBook(locIds?: string[]): Finding[] {
  const out: Finding[] = []
  const locs = idx.data.locations.filter((l) => !locIds?.length || locIds.includes(l.id))
  const all = idx.data.locations.flatMap((l) => l.paragraphs.map((p) => ({ loc: l.id, p, tree: paragraphTree(p), P: `${l.id}:${p.n}` })))
  // условия «по отметке» другого помещения
  const refs = new Map<string, string[]>()
  for (const x of all) refs.set(x.P, [...new Set(allNodes(x.tree).flatMap((n) => (typeof n.on === 'object' && 'mark' in n.on ? n.on.mark : [])))])
  const ext = (P: string, reachable?: Set<string>) => (refs.get(P) ?? []).filter((m) => !m.startsWith(`${P}:`) && (!reachable || reachable.has(m)))
  // первый проход — отметки других помещений считаются достижимыми; по его итогу — какие отметки ставятся на самом деле
  const first = new Map(all.map((x) => [x.P, explore(x.tree, x.P, ext(x.P))]))
  const reachable = new Set([...first.values()].flatMap((e) => [...e.marks]))
  for (const x of all) {
    if (!locs.some((l) => l.id === x.loc)) continue
    const hand = !!x.p.tree
    const push = (f: Omit<Finding, 'loc' | 'n' | 'hand'>) => out.push({ loc: x.loc, n: x.p.n, hand, ...f })
    const e = (refs.get(x.P) ?? []).some((m) => !m.startsWith(`${x.P}:`)) ? explore(x.tree, x.P, ext(x.P, reachable)) : first.get(x.P)!
    for (const m of refs.get(x.P) ?? []) if (!reachable.has(m)) push({ level: 'error', what: `условие по отметке ${m}, которую игра не ставит` })
    if (e.truncated) push({ level: 'warn', what: `больше ${MAX_STATES} состояний — достижимость части этапов не проверена` })
    for (const n of allNodes(x.tree)) {
      if (e.opened.has(n.id) || repeatOption(x.tree, n)) continue
      const how = typeof n.on === 'object' ? JSON.stringify(n.on) : n.on
      push({ id: n.id, level: 'error', what: `этап не открывается ни в одной игре (on: ${how}${n.label ? `, «${n.label}»` : ''})` })
    }
    for (const n of allNodes(x.tree)) {
      if (!e.opened.has(n.id)) continue
      if (n.hints?.luck?.length) {
        const ok = e.fruitful.get(`${x.P}:${n.id}:ok`), fail = e.fruitful.get(`${x.P}:${n.id}:fail`)
        const penalty = !hand && n.hints.luck.some((t) => luckPenalty([n.label ?? '', nodeFullText(n)].join(' '), t))
        // нет ни одного итога — проверку не встретили (обход по частям)
        if (ok === false && fail === false && !penalty && !known(x.P, n.id, 'luck')) push({ id: n.id, level: 'warn', what: `проверка удачи ${n.hints.luck.join(', ')} ни на что не влияет (ни удача, ни неудача ничего не открывают)` })
      }
      if (n.dice && !n.dice.repeat) {
        const empty: number[] = []
        for (let r = 1; r <= n.dice.sides; r++) if (e.fruitful.get(`${x.P}:${diceKey(n)}:roll=${r}`) === false) empty.push(r)
        if (empty.length && !known(x.P, n.id, 'dice')) push({ id: n.id, level: 'warn', what: `к${n.dice.sides}: ${empty.length > 1 ? 'грани' : 'грань'} ${empty.join(', ')} ничего не открывают («ничего не происходит»)` })
      }
    }
    integrity(x.tree, x.loc, push)
    textChecks(x.tree, hand, push)
  }
  return out
}

/** Тихий контекст ведущего: сообщения только в комнате */
const QUIET: GmContext = {
  stateChanged() {}, roomChanged() {}, chat: (room, m) => room.addChat(m), updateChat() {}, delta() {}, done() {}, notice() {}, persist() {},
}

/** Что сценарный ведущий не должен говорить никогда: сбой разметки или кода */
const BAD_SAY = /undefined|NaN|\[object |Вариант не найден|Список не найден|пока недоступен|Неверная отметка|Нет такого места|уже применены|нет последствий/

/** Отказы движка, которые бывают в честной игре: из фонтана уже пили, никого нет на ногах */
const REFUSAL_OK = /сегодня уже пили|не может сражаться|нет живых героев|уже выбыл/

/**
 * Сценарный ведущий на настоящей сессии: каждый параграф — walks случайных игр кнопками (бой кончается победой,
 * поражением или бегством; в половине игр у героев есть вещи passWith). Ошибки: исключение из кода, реплика с BAD_SAY,
 * пустая подпись кнопки, отметка прохождения, которой нет в модели обхода (бот и ведущий разошлись).
 */
export interface ScriptRuns {
  findings: Finding[]
  games: number
  presses: number
  /** отметки модели обхода, которые ведущий поставил хотя бы в одной игре, — из всех отметок модели */
  covered: number
  total: number
  /** отметки модели, которые в играх ведущего не встретились (редкие грани к18, повторные бои) */
  missing: string[]
}
export function scriptRuns(locIds?: string[], walks = 24): ScriptRuns {
  const out: Finding[] = []
  let games = 0, presses = 0, covered = 0, total = 0
  const missing: string[] = []
  for (const loc of idx.data.locations) {
    if (locIds?.length && !locIds.includes(loc.id)) continue
    for (const p of loc.paragraphs) {
      const P = `${loc.id}:${p.n}`
      const tree = paragraphTree(p)
      const hand = !!p.tree
      const issues = new Set<string>()
      const issue = (what: string) => issues.add(what)
      const ext = allNodes(tree).flatMap((n) => (typeof n.on === 'object' && 'mark' in n.on ? n.on.mark : [])).filter((m) => !m.startsWith(`${P}:`))
      const model = new Set([...explore(tree, P, ext).marks].filter((m) => m.startsWith(`${P}:`)))
      const pass = [...new Set(allNodes(tree).flatMap((n) => (n.passWith ? [n.passWith] : [])))]
      const got = new Set<string>()
      for (let w = 0; w < walks; w++) {
        games++
        setRng(seededRng(hash(`${P}#${w}`)))
        // выбор бота — свой генератор, чтобы игры не зависели от числа бросков в движке
        const random = seededRng(hash(`${P}#${w}#bot`))
        const room = new Room('BOT', 'script', blankGame(), world as unknown as WorldMap)
        const s = room.session()
        s.quickStart()
        const player = room.addPlayer('Бот', true)
        player.heroUids = room.state.heroes.map((h) => h.uid)
        room.state.locationId = loc.id
        if (w % 2) for (const it of pass) s.giveItem(room.state.heroes[0].uid, 'item', it)
        // денег хватает на любую плату книги (иначе вариант с платой не откроется)
        for (const h of room.state.heroes) h.money += 1000
        const gm = new ScriptedGm(QUIET)
        let seen = 0
        const scan = () => {
          for (const m of room.chat.slice(seen)) {
            if (m.from !== 'gm') continue
            const bad = BAD_SAY.exec(m.text)
            if (bad) issue(`ведущий говорит «${bad[0]}»: ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`)
            for (const { label: l } of m.choices ?? []) if (!l.replace(/^[▸⚔🎲🗝]\s*/u, '').trim() || BAD_SAY.test(l)) issue(`кнопка с пустой или сломанной подписью: «${l}»`)
            // одинаковые подписи бывают у разных находок («по 100 монет каждый» — две кнопки); одно и то же действие дважды — сбой
            const acts = (m.choices ?? []).map((c) => JSON.stringify(room.choiceActions[c.id]?.action ?? null))
            const dup = acts.findIndex((a, i) => acts.indexOf(a) !== i)
            if (dup >= 0) issue(`одно и то же действие двумя кнопками: «${m.choices![dup].label}»`)
          }
          seen = room.chat.length
        }
        const guard = (what: string, fn: () => void) => {
          try { fn() } catch (e) { issue(`${what}: исключение ${(e as Error).name}: ${(e as Error).message}`) }
        }
        guard('вход в параграф', () => gm.presentParagraph(room, loc.id, p.n, player.id))
        scan()
        for (let step = 0; step < 40; step++) {
          const c = room.state.combat
          if (c) {
            const r = random()
            const outcome = r < 0.7 ? 'victory' : r < 0.85 ? 'defeat' : 'fled'
            if (outcome === 'victory') { for (const m of c.monsters) m.dead = true; checkEnd(c, room.state.heroes) } else c.finished = outcome
            guard('конец боя', () => { room.session().endCombat(); gm.handle(room, [{ type: 'combatEnd', outcome, text: 'Бой окончен.' }], []) })
            scan()
            continue
          }
          const options = room.chat.flatMap((m) => (m.from === 'gm' ? (m.choices ?? []).filter((x) => !m.used?.includes(x.id) && room.choiceActions[x.id] && room.choiceActions[x.id].action.t !== 'next').map((x) => ({ m, x })) : []))
          if (!options.length) break
          const pick = options[Math.floor(random() * options.length)]
          presses++
          guard(`кнопка «${pick.x.label}»`, () => gm.choose(room, player.id, pick.m.id, pick.x.id))
          // действие не прошло (движок отказал) — кнопка снова доступна, а ведущий пересказал отказ
          if (!pick.m.used?.includes(pick.x.id)) {
            const said = room.chat.at(-1)?.text ?? ''
            if (!REFUSAL_OK.test(said)) issue(`кнопка «${pick.x.label}» не сработала: ${said.slice(0, 160)}`)
          }
          scan()
        }
        for (const k of room.state.claimed ?? []) {
          if (!k.startsWith(`${P}:`) || k.endsWith(':fx')) continue
          // бой на исходе броска «на каждый» отмечается на самом исходе — в модели таких этапов нет (они не открываются)
          const at = findNode(tree, k.slice(P.length + 1, k.lastIndexOf(':')))
          if (at && repeatOption(tree, at)) continue
          got.add(k)
          if (!model.has(k)) issue(`ведущий поставил отметку ${k}, которой нет в модели обхода`)
        }
      }
      for (const what of issues) out.push({ loc: loc.id, n: p.n, level: 'error', what: `сценарный ведущий: ${what}`, hand })
      total += model.size
      covered += [...model].filter((m) => got.has(m)).length
      missing.push(...[...model].filter((m) => !got.has(m)))
    }
  }
  return { findings: out, games, presses, covered, total, missing }
}

/** Число из строки (семя случайности игры бота) */
function hash(t: string): number {
  let h = 2166136261
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619)
  return h >>> 0
}

const LEVEL: Record<Level, string> = { error: 'Ошибки', warn: 'Предупреждения', check: 'Для ручной проверки' }

/** Отчёт в Markdown: по уровням, внутри — по главам и параграфам */
export function report(findings: Finding[]): string {
  const lines = ['# Обход Книги Жизни ботом', '', `Ошибок: ${count(findings, 'error')}, предупреждений: ${count(findings, 'warn')}, для ручной проверки: ${count(findings, 'check')}.`, '']
  for (const level of ['error', 'warn', 'check'] as Level[]) {
    const fs = findings.filter((f) => f.level === level)
    if (!fs.length) continue
    lines.push(`## ${LEVEL[level]} (${fs.length})`, '')
    for (const l of idx.data.locations) {
      const here = fs.filter((f) => f.loc === l.id)
      if (!here.length) continue
      lines.push(`### ${l.name} (\`${l.id}\`)`, '')
      for (const f of here) lines.push(`- § ${f.n}${f.id ? ` · ${f.id}` : ''}${f.hand ? '' : ' (старая разметка)'}: ${f.what}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}
const count = (fs: Finding[], l: Level) => fs.filter((f) => f.level === l).length

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const t = Date.now()
  const locs = process.argv.slice(2)
  const runs = scriptRuns(locs)
  const fs = [...walkBook(locs), ...runs.findings]
  const dir = new URL('./out/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  writeFileSync(new URL('book-walk.md', dir), report(fs))
  console.log(`Обход за ${((Date.now() - t) / 1000).toFixed(1)} с. Ошибок: ${count(fs, 'error')}, предупреждений: ${count(fs, 'warn')}, для ручной проверки: ${count(fs, 'check')}.`)
  console.log(`Сценарный ведущий: ${runs.games} игр, ${runs.presses} нажатий; поставлено ${runs.covered} из ${runs.total} отметок модели (${Math.round((100 * runs.covered) / runs.total)}%).`)
  console.log('Отчёт: tools/qa/out/book-walk.md')
}
