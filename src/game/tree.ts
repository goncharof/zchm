/**
 * Дерево параграфа Книги Жизни (docs/BOOK_STRUCTURE.md, разделы 3 и 7): этапы с дословными кусками текста,
 * условием открытия и механикой. Размеченные вручную параграфы хранят дерево в данных (`tree`), остальные получают
 * его на лету из старой разметки (сцена и ветки). Что уже открыто, считается из отметок прохождения в `state.claimed`.
 */
import { idx } from '@/data'
import type { BookNode, NodeOn, Paragraph, ParagraphHints, ParagraphSegment } from '@/types'
import { paragraphSegments, rollSides } from './book'

/** В подсказках есть монстр, с которым можно сразиться (не Мерлин, не торговец) */
export const canFightHints = (h?: ParagraphHints) => (h?.monsters ?? []).some((m) => !idx.monsterById.get(m)?.special)

const WHEN = { win: 'win', lose: 'lose', luckOk: 'ok', luckFail: 'fail' } as const

/** Ветка или сцена → этап; списки бросков — `dice` этапа и дети «i:j:rk» (как ключи наград одиночной игры) */
function fromSegment(g: ParagraphSegment, id: string, on: NodeOn): BookNode {
  const node: BookNode = { id, on, text: [] }
  if (g.label) node.label = g.label
  if (g.hints && Object.keys(g.hints).length) node.hints = g.hints
  const kids: BookNode[] = []
  g.blocks.forEach((b, j) => {
    if ('text' in b) { node.text.push({ t: b.text }); return }
    const key = `${id}:${j}`
    const options: BookNode[] = b.roll.map((o, k) => ({ id: `${key}:r${k}`, on: { roll: o.values }, text: [{ t: o.text }], ...(o.hints ? { hints: o.hints } : {}) }))
    const dice = { sides: rollSides(b.roll), key, ...(b.repeat ? { repeat: true as const } : {}) }
    // второй список в той же части — отдельный этап, открытый вместе с ней
    if (!node.dice) { node.dice = dice; kids.push(...options) }
    else kids.push({ id: key, on: 'enter', text: [], dice, then: options })
  })
  if (kids.length) node.then = kids
  return node
}

/** Дерево параграфа: ручное из данных или из сцены и веток. Исходы боя и удачи висят на корне — их откроет итог
 *  любого боя или проверки в параграфе, как раньше; без боя или проверки в параграфе такая ветка — обычный выбор */
export function paragraphTree(p: Paragraph): BookNode {
  if (p.tree) return p.tree
  const segs = paragraphSegments(p)
  const canFight = segs.some((g) => canFightHints(g.hints))
  const canLuck = segs.some((g) => (g.hints?.luck ?? []).length > 0)
  const root = fromSegment(segs.find((g) => g.kind === 'scene') ?? { kind: 'scene', blocks: [] }, p.segments ? '0' : 'p', 'enter')
  const kids: BookNode[] = []
  segs.forEach((g, i) => {
    if (g.kind === 'scene') return
    // условие без текста («Если у вас нет ключа, то уходите») — пояснение, видно сразу
    if (!g.blocks.length) { kids.push({ id: String(i), on: 'enter', text: [{ t: `${g.label}.` }] }); return }
    const later = g.when && (g.when === 'win' || g.when === 'lose' ? canFight : canLuck)
    kids.push(fromSegment(g, String(i), later ? WHEN[g.when!] : 'choice'))
  })
  if (kids.length) root.then = [...(root.then ?? []), ...kids]
  return root
}

/** Отметки итога: этап `id` → `место:id:won` и т. д. */
const RESULT = { win: 'won', lose: 'lost', flee: 'fled', ok: 'ok', fail: 'fail' } as const
export type BookResult = (typeof RESULT)[keyof typeof RESULT]

/** Все этапы дерева по порядку (полный текст, проверки данных) */
export function allNodes(root: BookNode): BookNode[] {
  return [root, ...(root.then ?? []).flatMap(allNodes)]
}

export function findNode(root: BookNode, id: string): BookNode | undefined {
  return allNodes(root).find((n) => n.id === id)
}

/** Ключ отметки броска списка этапа */
export const diceKey = (n: BookNode) => n.dice?.key ?? n.id

/**
 * Открытые этапы параграфа по порядку чтения. place — «локация:номер», claimed — отметки прохождения:
 * `место:id:open` (выбран вариант), `место:id:won|lost|fled|ok|fail` (итог боя или проверки этапа),
 * `место:ключ:roll=r` (бросок по списку). Исход боя или удачи открывается, если такой итог отмечен у родителя или у
 * этапа в его поддереве, у которого своих исходов этого вида нет (старая разметка вешает исходы на корень).
 */
export function openNodes(root: BookNode, place: string, claimed: readonly string[] = []): BookNode[] {
  const set = new Set(claimed)
  const marked = (id: string, what: string) => set.has(`${place}:${id}:${what}`)
  const rolled = (key: string) => claimed.filter((k) => k.startsWith(`${place}:${key}:roll=`)).map((k) => Number(k.slice(k.indexOf('=') + 1)))
  const resultIn = (parent: BookNode, on: keyof typeof RESULT): boolean => {
    const what = RESULT[on]
    const own = (n: BookNode) => (n.then ?? []).some((c) => c.on === on)
    return allNodes(parent).some((n) => marked(n.id, what) && (n === parent || !own(n)))
  }
  const opens = (parent: BookNode, c: BookNode): boolean => {
    const on = c.on
    if (on === 'enter') return true
    if (on === 'choice') return marked(c.id, 'open')
    if (typeof on === 'object') return !!parent.dice && !parent.dice.repeat && rolled(diceKey(parent)).some((r) => on.roll.includes(r))
    return resultIn(parent, on)
  }
  const out: BookNode[] = []
  const visit = (n: BookNode) => {
    out.push(n)
    for (const c of n.then ?? []) if (opens(n, c)) visit(c)
  }
  visit(root)
  return out
}

/** Этапы, которые открылись после новой отметки (по порядку чтения) */
export function revealedBy(root: BookNode, place: string, claimed: readonly string[], mark: string): BookNode[] {
  const before = new Set(openNodes(root, place, claimed.filter((k) => k !== mark)).map((n) => n.id))
  return openNodes(root, place, claimed.includes(mark) ? claimed : [...claimed, mark]).filter((n) => !before.has(n.id))
}

/** Варианты выбора, которые сейчас можно сделать: дети открытых этапов с on: choice, ещё не выбранные
 *  (у exclusive-этапа — пока не выбран ни один) */
export function openChoices(root: BookNode, place: string, claimed: readonly string[] = []): BookNode[] {
  const open = openNodes(root, place, claimed)
  const ids = new Set(open.map((n) => n.id))
  return open.flatMap((n) => {
    const choices = (n.then ?? []).filter((c) => c.on === 'choice')
    if (n.exclusive && choices.some((c) => ids.has(c.id))) return []
    return choices.filter((c) => !ids.has(c.id))
  })
}

/** Текст этапа для игроков: без пометок ведущего */
export function nodeText(n: BookNode): string {
  return n.text.filter((x) => !x.gm).map((x) => x.t).join(' ')
}

/** Полный текст этапа (вместе с пометками ведущего) */
export function nodeFullText(n: BookNode): string {
  return n.text.map((x) => x.t).join(' ')
}

/** Итог проверки этапа уже отмечен */
export function hasResult(place: string, id: string, claimed: readonly string[], ...what: BookResult[]): boolean {
  return what.some((w) => claimed.includes(`${place}:${id}:${w}`))
}
