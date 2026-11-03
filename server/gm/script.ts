/**
 * Сценарный ведущий без ИИ: ведёт игру по дереву этапов Книги Жизни (src/game/tree.ts).
 * Показывает открытые этапы параграфа и их кнопки; выбранный вариант выполняет движком, исходы боя и проверок открывает сам.
 * Работает как самостоятельный режим и как запасной ведущий, когда модели ИИ недоступны.
 */
import { randomUUID } from 'node:crypto'
import { idx } from '@/data'
import type { BookNode, ParagraphHints } from '@/types'
import { allNodes, canFightHints, deadlyEffect, diceKey, effectLabel, findNode, gameLimit, gamesPlayed, hasResult, nodeFullText, nodeText, openNodes, paragraphTree, parentOf, revealedBy, rollOf, stakeLabel } from '@/game/tree'
import type { Hero } from '@/engine/model'
import { hasWard, isConscious } from '@/engine/character'
import { UNDEAD } from '@/engine/combat'
import { GameError } from '@/game/session'
import { plural } from '@/ui/format'
import { DEAD_AT } from '@/engine/rules'
import type { ChatChoice, ChatMessage } from '@/net/protocol'
import type { Room, ScriptAction } from '../rooms'
import type { GmContext, GmEvent } from './types'

export const SCRIPT_AUTHOR = 'Ведущий · сценарий'

interface Offer {
  label: string
  action: ScriptAction
}


/** Где в книге стоит кнопка: параграф и этап (src/game/tree.ts) */
interface Place { loc: string; n: number; id: string }

function treeAt(loc: string, n: number): BookNode | undefined {
  const p = idx.locationById.get(loc)?.paragraphs.find((x) => x.n === n)
  return p ? paragraphTree(p) : undefined
}

/** Номер бутылки в тексте книги — пометка ведущего: герои видят просто бутылку, а что в ней, узнают заклинанием
 *  «Идентификация предметов», распознавателем (только «опасна или нет») или выпив. Игрокам текст книги показывается
 *  с «(бутылка)» вместо «(5)» */
const shown = (t: string) => t.replace(/\(([1-6])\)/g, '(бутылка)')

/** Текст этапа для чата: «условие — текст» (у исхода броска — выпавшие числа), без пометок ведущего */
function nodeSay(node: BookNode): string {
  const body = nodeText(node)
  const roll = rollOf(node)
  const head = roll ? `Выпало ${roll.join(', ')}` : node.on === 'enter' ? '' : node.label
  return shown(head ? `${head}${body ? ` — ${body}` : ''}` : body)
}

export interface LuckPenalty { kind: 'death' | 'lives' | 'half'; amount?: number; text: string }

/** Последствие провала из текста: «удача — 6, иначе смерть», «Удача — 14, иначе — -2 жизни», «иначе половина жизней исчезает»,
 *  «удача — 4. Иначе — верная смерть» (через точку) */
export function luckPenalty(text: string, target: number): LuckPenalty | null {
  const m = new RegExp(`удач[аеи]\\s*[—–-]?\\s*${target}(?!\\d)[^.]{0,20}?\\.?\\s*иначе\\s*[—–-]?\\s*((?:верная\\s+)?смерть|[-−–]?\\s*(\\d+)\\s*жизн\\S*|половина жизней)`, 'i').exec(text)
  if (!m) return null
  if (/смерть/i.test(m[1])) return { kind: 'death', text: 'смерть' }
  if (/половина/i.test(m[1])) return { kind: 'half', text: 'половина жизней' }
  const amount = Number(m[2])
  return { kind: 'lives', amount, text: `−${amount} ${plural(amount, 'жизнь', 'жизни', 'жизней')}` }
}

/** Кнопки по подсказкам из текста. place — этап книги: ключи одноразовых наград, привязка боя и проверки удачи */
const coinsWord = (n: number) => `${n} ${plural(n, 'монету', 'монеты', 'монет')}`

/** Бутылки на продажу по тексту: «бутылку (5) за 15 монет», «за каждую просит 10 монет», «по 5 монет каждую», «бутылки (4)
 *  за 5 монет и (5) за 10 монет», «2 бутылки за 20 монет: (3), (3)». Пусто — монеты и бутылки в тексте не связаны покупкой
 *  (подарок и просьба о деньгах, награда в лодке, совет за плату). */
export function bottleSales(text: string, h: ParagraphHints): { bottles: number[]; price: number; stock: number }[] {
  const prices = h.prices ?? [], bottles = h.bottles ?? []
  const t = text.toLowerCase().replace(/ё/g, 'е')
  if (!prices.length || !bottles.length || !/бутыл/.test(t)) return []
  // запас: «(4) за 5 монет (у него 4 бутылки)», «у него целых 4 таких бутылки»; иначе — сколько бутылок названо
  const stockOf = (n: number) => Number(new RegExp(`\\(${n}\\)[^()]*?\\(у него (\\d+) бутыл`).exec(t)?.[1] ?? 0) || bottles.filter((b) => b === n).length
  if (prices.length > 1) return prices.length === bottles.length ? bottles.map((n, i) => ({ bottles: [n], price: prices[i], stock: stockOf(n) })) : []
  const price = prices[0]
  const each = /за кажд/.test(t) || new RegExp(`бутыл[^.]*по ${price} монет\\S* кажд`).test(t)
  if (!each && !new RegExp(`бутыл[^.]*за ${price} монет`).test(t)) return []
  // несколько бутылок за одну цену — одна покупка
  if (!each && new RegExp(`(\\d+|две|три|четыре) бутыл\\S* за ${price} монет`).test(t)) return [{ bottles, price, stock: 1 }]
  const kinds = [...new Set(bottles)]
  const total = Number(/у него (?:целых )?(\d+) (?:таких )?бутыл/.exec(t)?.[1] ?? 0)
  return kinds.map((n) => ({ bottles: [n], price, stock: kinds.length === 1 && total ? total : stockOf(n) }))
}

function hintOffers(h: ParagraphHints | undefined, place?: Place, text = ''): Offer[] {
  if (!h) return []
  const out: Offer[] = []
  const sales = bottleSales(text, h)
  if (sales.length) h = { ...h, prices: [], bottles: [] }
  const once = (what: string) => (place ? `${place.loc}:${place.n}:${place.id}:${what}` : undefined)
  const fightable = (h.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special)
  if (fightable.length) {
    const specs = fightable.map((m) => ({ monsterId: m, count: h.monsterCounts?.[m] ?? 1 }))
    out.push({ label: `⚔ Бой: ${specs.map((s) => `${idx.monster(s.monsterId).name}${s.count > 1 ? ` ×${s.count}` : ''}`).join(', ')}`, action: { t: 'fight', specs, ...place } })
  }
  for (const t of h.luck ?? []) out.push({ label: `🎲 Проверка удачи ${t}`, action: { t: 'luck', target: t, ...place } })
  // покупка расходует запас торговца: по ключу на каждую бутылку, из них показывается первая не купленная (fresh)
  for (const sale of sales) {
    const what = sale.bottles.length > 1 ? `${sale.bottles.length} ${plural(sale.bottles.length, 'бутылку', 'бутылки', 'бутылок')}` : 'бутылку'
    for (let k = 1; k <= sale.stock; k++) out.push({ label: `Купить ${what} за ${coinsWord(sale.price)}`, action: { t: 'buy', bottles: sale.bottles, price: sale.price, once: once(`buy:${sale.bottles.join('+')}#${k}`) } })
  }
  for (const c of h.prices ?? []) out.push({ label: `Заплатить ${coinsWord(c)}`, action: { t: 'pay', amount: c } })
  // одинаковые суммы — отдельные находки (вторая получает свой ключ: взяли одну — другая осталась)
  const seen = new Map<number, number>()
  for (const c of h.coins ?? []) {
    const k = (seen.get(c) ?? 0) + 1
    seen.set(c, k)
    out.push({ label: `Забрать ${coinsWord(c)}`, action: { t: 'coins', amount: c, once: once(k > 1 ? `coins:${c}#${k}` : `coins:${c}`) } })
  }
  // все бутылки находки — одной кнопкой и без номеров («Взять 3 бутылки»), раздать можно потом в разделе «Партия»
  const bs = h.bottles ?? []
  if (bs.length) out.push({ label: bs.length > 1 ? `Взять ${bs.length} ${plural(bs.length, 'бутылку', 'бутылки', 'бутылок')}` : 'Взять бутылку', action: { t: 'bottle', ns: bs, once: once(`bottle:${[...new Set(bs)].sort().join('+')}`) } })
  if (h.artifact) out.push({ label: 'Взять артефакт', action: { t: 'artifact', once: once('artifact') } })
  ;(h.scrolls ?? []).forEach((s, i) => out.push({ label: `Взять свиток${s.level !== undefined ? ` ${s.level} ур.` : ''}`, action: { t: 'scroll', caster: s.caster, level: s.level, once: once(`scroll:${i}`) } }))
  ;(h.items ?? []).forEach((it, i) => out.push({ label: `Взять: ${itemName(it.kind, it.id)}${(it.qty ?? 1) > 1 ? ` ×${it.qty}` : ''}`, action: { t: 'item', kind: it.kind, id: it.id, qty: it.qty, once: once(`item:${i}`) } }))
  if (h.tavern) out.push({ label: 'Отдохнуть сутки (2 монеты)', action: { t: 'rest' } })
  return out
}

const itemName = (kind: 'weapon' | 'armor' | 'item' | 'scroll', id: string) => kind === 'scroll' ? `свиток «${idx.spellById.get(id)?.name ?? id}»` : (kind === 'weapon' ? idx.weaponById : kind === 'armor' ? idx.armorById : idx.itemById).get(id)?.name ?? id

/** Кнопки открытого этапа: механика из подсказок (бой — пока не выигран, проверка удачи — пока не пройдена), бросок
 *  по списку — пока не брошен (списки «для каждого» — сколько угодно), невыбранные варианты-дети */
function nodeOffers(loc: string, n: number, node: BookNode, claimed: readonly string[], open: Set<string>, heroes: Hero[] = []): Offer[] {
  const P = `${loc}:${n}`
  let h = node.hints
  if (h && hasResult(P, node.id, claimed, 'won')) h = { ...h, monsters: [] }
  if (h && hasResult(P, node.id, claimed, 'ok')) h = { ...h, luck: [] }
  const out = hintOffers(h, { loc, n, id: node.id }, nodeFullText(node))
  // проверку удачи заменяет (или замок открывает) предмет: кнопка, пока этап не пройден и предмет есть у живого героя
  if (node.passWith && !hasResult(P, node.id, claimed, 'ok') && heroes.some((x) => !x.status.dead && x.inventory.some((e) => e.kind === 'item' && e.ref === node.passWith))) {
    out.unshift({ label: `🗝 Открыть: ${itemName('item', node.passWith)}`, action: { t: 'pass', loc, n, id: node.id } })
  }
  if (node.action === 'final-duel' && !hasResult(P, node.id, claimed, 'won')) out.unshift({ label: '⚔ Атаковать Чёрного мага (удача 15)', action: { t: 'duel' } })
  if (node.action === 'fountain') out.push({ label: 'Выпить из фонтана', action: { t: 'fountain' } })
  const d = node.dice
  if (d && (d.repeat || !claimed.some((k) => k.startsWith(`${P}:${diceKey(node)}:roll=`)))) out.push({ label: d.repeat ? `🎲 Бросить к${d.sides} (на каждый)` : `🎲 Бросить к${d.sides} по списку`, action: { t: 'roll', loc, n, id: node.id } })
  const g = node.hints?.game
  if (g && gamesPlayed(P, node.id, claimed) < gameLimit(node)) out.push({ label: `🎲 Сыграть в кости${stakeLabel(g)}`, action: { t: 'game', loc, n, id: node.id } })
  const choices = (node.then ?? []).filter((c) => c.on === 'choice')
  if (!(node.exclusive && choices.some((c) => open.has(c.id)))) {
    for (const c of choices) if (!open.has(c.id)) out.push({ label: `▸ ${shown(c.label ?? '')}`, action: { t: 'node', loc, n, id: c.id } })
  }
  return out
}

/** Убрать уже сделанные одноразовые действия */
function fresh(room: Room, offers: Offer[]): Offer[] {
  const taken = new Set(room.script.taken ?? [])
  const left = offers.filter((o) => !o.action.once || !taken.has(o.action.once))
  // покупки одной и той же бутылки — одна кнопка с остатком запаса
  const stock = new Map<string, number>()
  for (const o of left) if (o.action.t === 'buy') stock.set(o.label, (stock.get(o.label) ?? 0) + 1)
  const shown = new Set<string>()
  return left.flatMap((o) => {
    if (o.action.t !== 'buy') return [o]
    if (shown.has(o.label)) return []
    shown.add(o.label)
    const n = stock.get(o.label) ?? 1
    return [n > 1 ? { ...o, label: `${o.label} (в запасе ${n})` } : o]
  })
}

/** Номер помещения в реплике: «помещение 5», «№ 5», «в 5» или реплика из одного числа (а не «даю ему 5 монет») */
/** Люди по Бестиарию — на них действует «Обаяние» («трактирщиков, стражников, но не торговцев») */
const HUMANS = new Set(['chelovek', 'strazhnik', 'rytsar', 'razboynik', 'berserker', 'amazonka', 'druid', 'belyy-mag', 'chernyy-zhrets'])

/** Противники параграфа, с которыми бой ещё не выигран: по открытым этапам (видимые) и по скрытым (засады за выбором) */
function foesAt(loc: string, n: number, claimed: readonly string[]): { visible: { id: string; count: number; node: BookNode }[]; hidden: boolean; npcs: string[] } {
  const tree = treeAt(loc, n)
  if (!tree) return { visible: [], hidden: false, npcs: [] }
  const P = `${loc}:${n}`
  const open = openNodes(tree, P, claimed)
  const ids = new Set(open.map((x) => x.id))
  const visible = open.flatMap((node) => (hasResult(P, node.id, claimed, 'won') ? [] : (node.hints?.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special).map((id) => ({ id, count: node.hints?.monsterCounts?.[id] ?? 1, node }))))
  const hidden = allNodes(tree).some((node) => !ids.has(node.id) && canFightHints(node.hints))
  const npcs = open.flatMap((node) => [...(node.hints?.monsters ?? []).filter((m) => idx.monsterById.get(m)?.special), ...(node.npcs ?? [])])
  return { visible, hidden, npcs: [...new Set(npcs)] }
}

const foeName = (f: { id: string; count: number }) => `${idx.monster(f.id).name}${f.count > 1 ? ` ×${f.count}` : ''}`

/** Характеристики монстра по Бестиарию («Чтение силы» вне боя) */
function monsterStats(id: string, count: number): string {
  const m = idx.monster(id)
  const attacks = Array.isArray(m.attacks) ? `атаки ${m.attacks.join('-')}` : m.attacks === 'death' ? 'смертельная атака' : m.attacks === 'magic' ? 'бьёт только магией' : 'не атакует'
  const magic = m.spells?.length ? `магия: ${m.spells.join(', ')} (маны ${m.mana ?? 0})` : 'магией не владеет'
  return `• ${m.name}${count > 1 ? ` ×${count}` : ''}: уровень ${m.level ?? '—'}, защита ${m.defense ?? '—'}, жизни ${m.lives ?? '—'}, ${attacks}, храбрость ${m.courage ?? 'нет'}; ${magic}.`
}

/** Ответ сценарного ведущего на заклинание, которое движок не отыгрывает: вердикт по дереву Книги Жизни и Бестиарию
 *  (ХАУСРУЛЫ, docs/RULES.md). Вне параграфа заклинанию не на что опереться */
function spellReply(room: Room, spell: NonNullable<GmEvent['spell']>): { text: string; offers?: Offer[] } {
  const c = room.state.combat
  const inFight = !!c && !c.finished
  const foes = inFight ? c!.monsters.filter((m) => !m.dead && !m.fled) : []
  const loc = room.script.locationId
  const n = room.script.n
  const here = loc && n != null ? foesAt(loc, n, room.state.claimed ?? []) : null
  const nowhere = `«${spell.name}»: партия не в помещении — заклинанию не на что опереться. Назовите номер помещения и примените его там.`
  const t = (lines: (string | false | undefined)[]) => lines.filter(Boolean).join('\n')
  const heroes = room.state.heroes.filter((h) => !h.status.dead && isConscious(h))
  switch (spell.id) {
    case 'priest-chtenie-sily': {
      if (foes.length) {
        const lines = foes.map((m) => {
          const attacks = Array.isArray(m.attacks) ? `атаки ${m.attacks.join('-')}` : m.attacks === 'death' ? 'смертельная атака' : m.attacks === 'magic' ? 'бьёт только магией' : 'не атакует'
          const magic = m.spells?.length ? `магия: ${m.spells.join(', ')} (маны ${m.mana ?? 0})` : 'магией не владеет'
          return `• ${m.name}: уровень ${m.level}, защита ${m.defense + m.defenseMod}, жизни ${m.lives}/${m.maxLives}, ${attacks}, храбрость ${m.courage ?? 'нет'}; ${magic}.`
        })
        return { text: t([`${spell.hero} читает силу противников:`, ...lines]) }
      }
      if (!here) return { text: nowhere }
      if (!here.visible.length) return { text: `${spell.hero} читает силу: рядом нет никого, кого стоило бы опасаться.${here.hidden ? ' Но что-то здесь всё же скрыто.' : ''}` }
      return { text: t([`${spell.hero} читает силу тех, кто здесь:`, ...here.visible.map((f) => monsterStats(f.id, f.count))]) }
    }
    case 'priest-chtenie-emotsiy': {
      if (foes.length) return { text: `${spell.hero} читает эмоции: ${foes.map((m) => m.name).join(', ')} — волны ненависти и злобы, они будут драться.` }
      if (!here) return { text: nowhere }
      const lines = [`${spell.hero} читает эмоции:`]
      for (const f of here.visible) lines.push(`• ${foeName(f)}: злоба и ненависть — нападёт.`)
      for (const id of here.npcs) lines.push(`• ${idx.monsterById.get(id)?.name ?? id}: спокоен, зла не держит.`)
      if (here.hidden) lines.push('• Поблизости чувствуется затаённая угроза: кто-то ждёт своего часа.')
      if (lines.length === 1) lines.push('вокруг никого с сильными чувствами.')
      return { text: t(lines) }
    }
    case 'priest-chuvstvo-zla': {
      if (!loc) return { text: nowhere }
      room.script = { ...room.script, sense: { kind: 'evil', left: 3 } }
      return { text: `${spell.hero} прислушивается к злу вокруг. ХАУСРУЛ: заклинание прощупывает до трёх соседних помещений — назовите их номера одной репликой, например «зло 7, 12».` }
    }
    case 'mage-ozhivlenie-teni':
    case 'mage-vselenie-dushi': {
      if (!loc) return { text: nowhere }
      const left = spell.id === 'mage-vselenie-dushi' ? 3 : 1
      room.script = { ...room.script, sense: { kind: 'scout', left } }
      return { text: `${spell.hero} ${spell.id === 'mage-vselenie-dushi' ? 'вселяется в мёртвое тело и отправляется на разведку' : 'оживляет свою тень и посылает её вперёд'}. ХАУСРУЛ: разведка показывает, что видно при входе в ${left === 1 ? 'одно соседнее помещение' : 'помещения (до трёх)'}, без наград и отметок — назовите ${left === 1 ? 'номер' : 'номера'} репликой «разведка 7».` }
    }
    case 'priest-ozarenie': {
      if (!here || !loc || n == null) return { text: nowhere }
      const tree = treeAt(loc, n)!
      const P = `${loc}:${n}`
      const open = openNodes(tree, P, room.state.claimed ?? [])
      const lines = [`Боги отвечают ${spell.hero}:`]
      for (const x of open) {
        for (const piece of x.text.filter((p) => p.gm)) lines.push(`• ${shown(piece.t)}`)
        if (x.teaser) lines.push(`• ${x.teaser}`)
      }
      // смертельно опасные пути среди ещё не выбранных вариантов
      const deadly = (x: BookNode): boolean => (x.effects ?? []).some(deadlyEffect) || (x.then ?? []).some((c) => c.on !== 'choice' && deadly(c))
      for (const x of open) for (const ch of (x.then ?? []).filter((c) => c.on === 'choice' && !open.includes(c))) if (deadly(ch)) lines.push(`• Остерегайтесь: «${shown(ch.label ?? '')}» — этот путь может стоить жизни.`)
      if (lines.length === 1) lines.push('здесь нет скрытых тайн и опасностей, о которых стоило бы предупредить.')
      return { text: t(lines) }
    }
    case 'priest-obayanie': {
      if (inFight) return { text: `«${spell.name}» в бою бессильно: противники уже взялись за оружие.` }
      if (!here) return { text: nowhere }
      const people = here.visible.filter((f) => HUMANS.has(f.id))
      const others = here.visible.filter((f) => !HUMANS.has(f.id))
      if (!here.visible.length) return { text: `${spell.hero} неотразим, но убеждать здесь некого.` }
      if (!people.length) return { text: `«${spell.name}» действует только на людей, а здесь ${here.visible.map(foeName).join(', ')}.` }
      return { text: t([`${spell.hero} убеждает ${people.map(foeName).join(', ')}: они пропускают вас без боя — бой можно не начинать (ХАУСРУЛ). Добыча, которую они стерегут, остаётся при них.`, others.length ? `На ${others.map(foeName).join(', ')} обаяние не действует.` : undefined]) }
    }
    case 'mage-nevidimaya-stena': {
      if (inFight) return { text: `${spell.hero} ставит невидимую стену: сквозь неё не пройдут ни ${foes.map((m) => m.name).join(', ')}, ни герои. ХАУСРУЛ: партия может отступить без погони — нажмите «Бежать» каждым героем или закончите бой отступлением.` }
      if (!here || !here.visible.length) return { text: `${spell.hero} ставит невидимую стену, но отгораживаться здесь не от кого.` }
      return { text: `${spell.hero} ставит невидимую стену между партией и ${here.visible.map(foeName).join(', ')}: они не доберутся до вас, и вы можете уйти без боя (ХАУСРУЛ). Всё, что за ними, остаётся за стеной.` }
    }
    case 'mage-nevidimost':
    case 'priest-otvorot-mertvetsov': {
      if (inFight) return { text: `«${spell.name}» наложено — движок учтёт его в этом бою.` }
      if (!here || !here.visible.length) return { text: `«${spell.name}» действует до ближайшего боя — там движок учтёт его сам.` }
      const undead = spell.id === 'priest-otvorot-mertvetsov'
      const covered = heroes.filter((h) => hasWard(h, undead ? 'undead' : 'invisible'))
      const uncovered = heroes.filter((h) => !covered.includes(h))
      const living = here.visible.filter((f) => !UNDEAD.has(f.id))
      if (undead && living.length) return { text: `«${spell.name}» отводит глаза только мертвецам, а здесь ${living.map(foeName).join(', ')} — живые, они вас заметят.` }
      if (uncovered.length) return { text: `${covered.map((h) => h.name).join(', ') || 'Никто'} ${covered.length === 1 ? 'может' : 'могут'} пройти мимо ${here.visible.map(foeName).join(', ')} незамеченным${covered.length === 1 ? '' : 'и'}, но ${uncovered.map((h) => h.name).join(', ')} — нет: заметят всю партию. Защита держится до ближайшего боя.` }
      return { text: `Под «${spell.name}» вся партия: ${here.visible.map(foeName).join(', ')} вас не заметят — бой можно не начинать, идите дальше (ХАУСРУЛ). Добыча за ними остаётся им.` }
    }
    case 'priest-vozvrat-vremeni':
    case 'mage-vozvrat-vremeni': {
      if (inFight) return { text: `«${spell.name}» в бою: цель перебрасывает кубики своего последнего действия — сценарный ведущий этого не считает, договоритесь за столом.` }
      if (!here || !loc || n == null) return { text: nowhere }
      const P = `${loc}:${n}`
      const tree = treeAt(loc, n)!
      // проваленные проверки удачи этого помещения можно отыграть назад: отметка провала снимается, кнопка возвращается
      const failed = allNodes(tree).filter((x) => hasResult(P, x.id, room.state.claimed ?? [], 'fail') && (x.hints?.luck?.length || x.hints?.game))
      if (!failed.length) return { text: `${spell.hero} возвращает время, но отыгрывать назад здесь нечего: проваленных проверок нет.` }
      return { text: `${spell.hero} возвращает время на один шаг: проваленную проверку можно повторить (ХАУСРУЛ).`, offers: failed.map((x) => ({ label: `⏪ Повторить: ${shown(x.label ?? (x.hints?.game ? 'игра в кости' : `удача ${x.hints?.luck?.join(', ')}`))}`, action: { t: 'rewind', loc, n, id: x.id } })) }
    }
    default:
      return { text: `«${spell.name}»: сценарный ведущий такие заклинания не отыгрывает — исход решите сами по описанию заклинания (ИИ-ведущий, когда он доступен, разыграет его по тексту книги).` }
  }
}

/** Ответ разведки на названные помещения: «Чувство зла» — враги по Бестиарию, тень — текст входа без наград */
function senseReply(room: Room, nums: number[]): string {
  const sense = room.script.sense!
  const loc = room.script.locationId
  if (!loc) { delete room.script.sense; return 'Партия вышла из локации — разведка не удалась.' }
  const lines: string[] = []
  for (const num of nums.slice(0, sense.left)) {
    const tree = treeAt(loc, num)
    if (!tree) { lines.push(`• ${num}: такого помещения нет на плане.`); continue }
    if (sense.kind === 'evil') {
      const foes = allNodes(tree).flatMap((x) => (x.hints?.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special).map((id) => ({ id, count: x.hints?.monsterCounts?.[id] ?? 1 })))
      const merged = new Map<string, number>()
      for (const f of foes) merged.set(f.id, Math.max(merged.get(f.id) ?? 0, f.count))
      lines.push(merged.size ? `• ${num}: зло — ${[...merged].map(([id, count]) => foeName({ id, count })).join(', ')}.` : `• ${num}: зла не чувствуется.`)
    } else {
      const entry = openNodes(tree, `${loc}:${num}`, []).map((x) => nodeText(x)).filter(Boolean).join(' ')
      lines.push(`• ${num}: ${shown(entry) || 'ничего не видно'}`)
    }
  }
  sense.left -= Math.min(nums.length, sense.left)
  if (sense.left <= 0) delete room.script.sense
  return lines.join('\n')
}

export function roomNumber(text: string): number | null {
  const m = text.match(/(?:помещени\S*|комнат\S*|номер|№|параграф\S*|§)\s*(\d{1,3})/i) ?? text.trim().match(/^(?:(?:идём|идем|идти|иду|заходим|входим)\s+)?(?:в\s+)?(\d{1,3})\s*[.!]?$/i)
  return m ? Number(m[1]) : null
}

export class ScriptedGm {
  constructor(private ctx: GmContext) {}

  /** Отправить сообщение ведущего с кнопками */
  private say(room: Room, text: string, offers: Offer[] = []): ChatMessage {
    const id = randomUUID()
    const choices: ChatChoice[] = offers.map((o) => {
      const cid = randomUUID().slice(0, 12)
      room.choiceActions[cid] = { messageId: id, action: o.action }
      return { id: cid, label: o.label }
    })
    return this.ctx.chat(room, { id, from: 'gm', author: SCRIPT_AUTHOR, text, ...(choices.length ? { choices, used: [] } : {}) })
  }

  /** Герой, который действует за игрока: его первый герой в сознании, иначе его первый живой, иначе первый в сознании
   *  или живой в партии (герой без сознания не сразится с Чёрным магом и не возьмёт находку) */
  private actor(room: Room, playerId?: string): Hero | undefined {
    const alive = room.state.heroes.filter((h) => !h.status.dead)
    const own = playerId ? room.players.get(playerId)?.heroUids ?? [] : []
    const mine = (h: Hero) => own.includes(h.uid)
    const awake = (h: Hero) => !h.status.unconscious
    return alive.find((h) => mine(h) && awake(h)) ?? alive.find(mine) ?? alive.find(awake) ?? alive[0]
  }

  /** Открыть параграф: открытые этапы (при первом входе — сцена) и их кнопки */
  presentParagraph(room: Room, locId: string, n: number, playerId?: string): void {
    const loc = idx.locationById.get(locId)
    const p = loc?.paragraphs.find((x) => x.n === n)
    if (!loc || !p) { this.say(room, `В «${loc?.name ?? locId}» нет помещения ${n}. Назовите номер с плана.`); return }
    const s = room.session()
    const before = (room.state.visited[loc.id] ?? []).includes(n)
    s.markVisited(loc.id, n)
    if (loc.id === 'doroga') s.dismissRoad(n)
    room.script = { ...room.script, locationId: loc.id, n }
    const head = loc.id === 'doroga' ? `В пути (§ ${n}).` : `${loc.name}, помещение ${n}${before ? ' (вы здесь уже были)' : ''}.`
    const nodes = openNodes(paragraphTree(p), `${loc.id}:${n}`, room.state.claimed)
    this.sayNodes(room, loc.id, n, [head], nodes, [], playerId, !before)
    this.ctx.stateChanged(room)
  }

  /** Рассказать открывшиеся этапы с их кнопками. Последствия этапов применяются сами (один раз, отметка в сессии);
   *  смерть и потеря половины жизней — кнопкой. jump — этапы открылись только что: переход в другое помещение выполняется */
  private sayNodes(room: Room, loc: string, n: number, head: string[], nodes: BookNode[], extra: Offer[] = [], playerId?: string, jump = true, done: Record<string, string[]> = {}): void {
    const s = room.session()
    const P = `${loc}:${n}`
    const actor = this.actor(room, playerId)
    const offers = [...extra]
    const text = nodes.map((x) => {
      const parts = [nodeSay(x)]
      // намёк, пока бой этапа не выигран: «Похоже, он что-то охраняет»
      if (x.teaser && !hasResult(P, x.id, room.state.claimed ?? [], 'won')) parts.push(x.teaser)
      if (done[x.id]) parts.push(`По книге: ${x.effects!.map(effectLabel).join(', ')}. ${done[x.id].join(' ')}`)
      else if (x.effects?.length && !(room.state.claimed ?? []).includes(`${P}:${x.id}:fx`)) {
        const label = x.effects.map(effectLabel).join(', ')
        if (x.effects.some(deadlyEffect)) offers.unshift({ label: `Принять последствия: ${label}`, action: { t: 'effects', loc, n, id: x.id, heroUid: actor?.uid } })
        else {
          try { parts.push(`По книге: ${label}. ${s.bookEffects(`${P}:${x.id}`, actor?.uid).join(' ')}`) }
          catch (e) { parts.push(`По книге: ${label}. ${(e as Error).message}`) }
        }
      }
      return parts.filter(Boolean).join('\n\n')
    })
    const claimed = room.state.claimed ?? []
    const tree = treeAt(loc, n)
    const open = new Set(tree ? openNodes(tree, P, claimed).map((x) => x.id) : [])
    offers.push(...fresh(room, nodes.flatMap((x) => nodeOffers(loc, n, x, claimed, open, room.state.heroes))), { label: 'Идти дальше', action: { t: 'next' } as ScriptAction })
    this.say(room, [...head, ...text].filter(Boolean).join('\n\n'), offers)
    // «летит в центр города (локация 41)» — партия переходит в названное помещение
    const to = jump ? nodes.find((x) => x.goto !== undefined)?.goto : undefined
    if (to !== undefined && to !== n) this.presentParagraph(room, loc, to, playerId)
  }

  /** События игры и реплики игроков */
  handle(room: Room, events: GmEvent[], texts: { author: string; text: string; playerId?: string }[]): void {
    for (const ev of events) {
      if (ev.type === 'travel') {
        const enc = ev.encounters ?? []
        // встреча может повториться в другом походе — взятое на ней в прошлый раз снова доступно
        if (enc.length) room.script.taken = (room.script.taken ?? []).filter((k) => !enc.some((n) => k.startsWith(`doroga:${n}:`)))
        this.say(room, `${ev.text}${enc.length ? '' : ' Куда дальше? Войдите в локацию с карты.'}`)
        for (const n of enc) this.presentParagraph(room, 'doroga', n)
      } else if (ev.type === 'enter') {
        const loc = room.state.locationId ? idx.locationById.get(room.state.locationId) : null
        room.script = { ...room.script, locationId: loc?.id ?? null, n: null }
        this.say(room, `Вы входите: «${loc?.name ?? ''}». Назовите номер помещения или нажмите его на плане.`)
      } else if (ev.type === 'combatEnd') {
        // бой начат не кнопкой ведущего (экран боя) — итог относится к параграфу, где стоит партия, и открывает исходы корня
        const here = room.script.locationId && room.script.n != null ? { loc: room.script.locationId, n: room.script.n } : undefined
        const f: { loc: string; n: number; id?: string } | undefined = room.script.fight ?? here
        delete room.script.fight
        const tree = f ? treeAt(f.loc, f.n) : undefined
        const what = ev.outcome === 'victory' ? 'won' : ev.outcome === 'fled' ? 'fled' : 'lost'
        let shownNodes: BookNode[] = []
        if (f && tree && ev.outcome) {
          const at = `${f.loc}:${f.n}:${f.id ?? tree.id}`
          // итог боя с кнопки этапа отметила сессия (endCombat); бой с экрана боя отмечается здесь
          if (f.id === undefined) room.session().bookMark(at, what)
          shownNodes = revealedBy(tree, `${f.loc}:${f.n}`, room.state.claimed ?? [], `${at}:${what}`)
        }
        if (f && shownNodes.length) this.sayNodes(room, f.loc, f.n, [ev.text], shownNodes)
        else this.say(room, `${ev.text} Продолжайте: выберите вариант выше или назовите номер следующего помещения.`)
      } else if (ev.type === 'spell' && ev.spell) {
        const r = spellReply(room, ev.spell)
        this.say(room, r.text, r.offers ?? [])
      } else if (ev.type === 'pass') {
        this.say(room, room.state.locationId ? 'Все готовы. Выберите вариант выше или назовите номер помещения на плане.' : 'Все готовы. Выберите путь на карте или войдите в локацию.')
      } else {
        this.say(room, ev.text)
      }
    }
    for (const t of texts) {
      // разведка заклинанием ждёт номера помещений: «зло 7, 12», «разведка 5»
      const sense = room.script.sense && t.text.match(/^\s*(?:зло|чу[юя]|чувств\S*|разведк\S*|тень|душ\S*)(?![а-яё])[^\d]*(\d[\d\s,и]*)/i)
      if (sense) { this.say(room, senseReply(room, [...new Set(sense[1].match(/\d+/g)!.map(Number))])); continue }
      const num = roomNumber(t.text)
      if (num !== null && room.state.locationId) this.presentParagraph(room, room.state.locationId, num, t.playerId)
      // в пути — только встречи, которые выпали партии
      else if (num !== null && room.state.pendingRoad.includes(num)) this.presentParagraph(room, 'doroga', num, t.playerId)
      else if (num !== null) this.say(room, room.state.pendingRoad.length ? `Встречи в пути: ${room.state.pendingRoad.map((x) => `§ ${x}`).join(', ')}.` : 'Сначала войдите в локацию с карты, потом назовите номер помещения.')
      else this.say(room, 'Сценарный ведущий понимает номера помещений на плане («помещение 5») и кнопки вариантов. Свободные реплики разбирает ИИ-ведущий, когда он доступен.')
    }
    // этапы, открытые событием (исход боя), могли изменить состояние: последствия, спутник
    this.ctx.stateChanged(room)
  }

  /** Нажата кнопка-вариант */
  choose(room: Room, playerId: string, messageId: string, choiceId: string): void {
    const rec = room.choiceActions[choiceId]
    const msg = room.chatById(messageId)
    if (!rec || rec.messageId !== messageId || !msg) throw new GameError('Этот вариант уже недоступен')
    if (msg.used?.includes(choiceId)) throw new GameError('Этот вариант уже выбран')
    msg.used = [...(msg.used ?? []), choiceId]
    this.ctx.updateChat(room, msg)
    const label = msg.choices?.find((c) => c.id === choiceId)?.label ?? ''
    const who = room.players.get(playerId)?.name ?? 'Игрок'
    this.ctx.chat(room, { from: 'player', author: who, text: `Выбор: ${label.replace(/^[▸⚔🎲]\s*/u, '')}`, toGm: true, playerId })
    try {
      const once = rec.action.once
      if (once && room.script.taken?.includes(once)) throw new GameError('Это уже сделано')
      this.apply(room, playerId, rec.action)
      if (once) room.script.taken = [...(room.script.taken ?? []), once]
    } catch (e) {
      if (!(e instanceof GameError) && !(e instanceof Error && e.name === 'GameError')) throw e
      // действие не удалось (не хватает монет и т.п.) — вариант снова доступен
      msg.used = (msg.used ?? []).filter((x) => x !== choiceId)
      this.ctx.updateChat(room, msg)
      this.say(room, (e as Error).message)
    }
    this.ctx.stateChanged(room)
  }

  private apply(room: Room, playerId: string, a: ScriptAction): void {
    const s = room.session()
    const hero = this.actor(room, playerId)
    const needHero = () => { if (!hero) throw new GameError('В партии нет живых героев'); return hero }
    switch (a.t) {
      case 'node':
      case 'branch': {
        // кнопки до 2026-10-20 ссылались на ветку seg — у дерева из старой разметки это этап с тем же номером
        const id = a.t === 'node' ? a.id : String(a.seg)
        const tree = treeAt(a.loc, a.n)
        const node = tree && findNode(tree, id)
        if (!tree || !node || node.on !== 'choice') throw new GameError('Вариант не найден')
        const P = `${a.loc}:${a.n}`
        const before = new Set(openNodes(tree, P, room.state.claimed).map((x) => x.id))
        if (before.has(id)) throw new GameError('Этот вариант уже выбран')
        if (!before.has(parentOf(tree, id)?.id ?? '')) throw new GameError('Этот вариант пока недоступен')
        // последствия выбранного варианта (плата, урон) — сразу и до отметки: не хватило монет — вариант остаётся
        const done: Record<string, string[]> = {}
        if (node.effects?.length && !node.effects.some(deadlyEffect)) done[id] = s.bookEffects(`${P}:${id}`, this.actor(room, playerId)?.uid)
        s.bookMark(`${P}:${id}`, 'open')
        this.sayNodes(room, a.loc, a.n, [], openNodes(tree, P, room.state.claimed).filter((x) => !before.has(x.id)), [], playerId, true, done)
        return
      }
      case 'pass': {
        const tree = treeAt(a.loc, a.n)
        const node = tree && findNode(tree, a.id)
        const P = `${a.loc}:${a.n}`
        if (!tree || !node?.passWith) throw new GameError('Вариант не найден')
        const holder = room.state.heroes.find((x) => !x.status.dead && x.inventory.some((e) => e.kind === 'item' && e.ref === node.passWith))
        if (!holder) throw new GameError(`Ни у кого нет предмета «${itemName('item', node.passWith)}»`)
        const before = new Set(openNodes(tree, P, room.state.claimed).map((x) => x.id))
        s.bookMark(`${P}:${a.id}`, 'ok')
        this.sayNodes(room, a.loc, a.n, [`${holder.name} пускает в ход: ${itemName('item', node.passWith)}.`], openNodes(tree, P, room.state.claimed).filter((x) => !before.has(x.id)), [], playerId)
        return
      }
      case 'effects': {
        const lines = s.bookEffects(`${a.loc}:${a.n}:${a.id}`, a.heroUid)
        this.say(room, lines.join(' '))
        return
      }
      case 'duel': {
        const h = needHero()
        const from = room.state.log.length
        const won = s.finalDuelAttack(h.uid)
        const said = room.state.log.slice(from).map((e) => e.text).join(' ')
        if (won) {
          // победа открывает этап «Если попадаете в Черного мага»
          const tree = treeAt('zamok-chernogo-maga', 13)
          const opened = tree ? revealedBy(tree, 'zamok-chernogo-maga:13', room.state.claimed ?? [], 'zamok-chernogo-maga:13:a:won') : []
          this.sayNodes(room, 'zamok-chernogo-maga', 13, [said, 'Победа! Чёрный маг повержен.'], opened, [], playerId)
        } else this.say(room, said, [{ label: '⚔ Атаковать Чёрного мага (удача 15)', action: { t: 'duel' } }, { label: 'Выпить из фонтана', action: { t: 'fountain' } }])
        return
      }
      case 'fountain':
        s.drinkFountain()
        this.say(room, room.state.log.at(-1)?.text ?? 'Партия пьёт из фонтана.')
        return
      case 'item': {
        const h = needHero()
        s.giveItem(h.uid, a.kind, a.id, a.qty ?? 1)
        this.say(room, `${h.name} берёт: ${itemName(a.kind, a.id)}${(a.qty ?? 1) > 1 ? ` ×${a.qty}` : ''}.`)
        return
      }
      case 'roll': {
        const tree = treeAt(a.loc, a.n)
        const P = `${a.loc}:${a.n}`
        // кнопки до 2026-10-20: список block части seg
        const node = tree && (a.id !== undefined ? findNode(tree, a.id) : allNodes(tree).find((x) => !!x.dice && diceKey(x) === `${a.seg}:${a.block}`))
        const d = node?.dice
        if (!tree || !node || !d) throw new GameError('Список не найден')
        const r = s.rollDie(d.sides, 'Бросок по списку')
        const hit = (node.then ?? []).find((c) => rollOf(c)?.includes(r))
        if (d.repeat) {
          // список «для каждого» бросают много раз; награда исхода — своя у каждого варианта и берётся один раз
          this.say(room, `Выпало ${r}: ${hit ? shown(nodeText(hit) || hit.label || '') : 'ничего не происходит'}`, hit ? fresh(room, nodeOffers(a.loc, a.n, hit, room.state.claimed ?? [], new Set(), room.state.heroes)) : [])
          return
        }
        // бросок по списку — один раз (иначе перебрасывали бы до награды)
        s.claim(`${P}:${diceKey(node)}:roll=${r}`)
        const opened = revealedBy(tree, P, room.state.claimed ?? [], `${P}:${diceKey(node)}:roll=${r}`)
        if (!opened.length) { this.say(room, `Выпало ${r}: ничего не происходит.`); return }
        this.sayNodes(room, a.loc, a.n, [], opened.map((x, i) => (i === 0 && x === hit ? { ...x, on: { roll: [r] } } : x)), [], playerId)
        return
      }
      case 'luck': {
        const h = needHero()
        const tree = a.loc !== undefined && a.n !== undefined ? treeAt(a.loc, a.n) : undefined
        const id = a.id ?? (a.seg !== undefined ? String(a.seg) : undefined)
        const node = tree && id !== undefined ? findNode(tree, id) : undefined
        const P = `${a.loc}:${a.n}`
        const before = tree ? new Set(openNodes(tree, P, room.state.claimed).map((x) => x.id)) : new Set<string>()
        const r = s.luckCheck(h.uid, a.target, node ? `${P}:${node.id}` : undefined)
        const head = `${h.name} испытывает удачу (${a.target}): к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} — ${r.ok ? 'удача!' : 'неудача.'}`
        if (!tree || !node) { this.say(room, head); return }
        // исходы этой проверки и последствие провала из текста этапа
        // у дерева, размеченного вручную, последствие провала — effects этапа fail; у старой разметки — из текста
        const hand = !!idx.locationById.get(a.loc!)?.paragraphs.find((x) => x.n === a.n)?.tree
        const pen = r.ok || hand ? null : luckPenalty([node.label ?? '', nodeFullText(node)].join(' '), a.target)
        const extra: Offer[] = pen ? [{ label: `Принять последствия: ${pen.text}`, action: { t: 'penalty', heroUid: h.uid, kind: pen.kind, amount: pen.amount } }] : []
        const opened = openNodes(tree, P, room.state.claimed).filter((x) => !before.has(x.id))
        this.sayNodes(room, a.loc!, a.n!, [pen ? `${head} По книге: иначе — ${pen.text}.` : head], opened, extra, playerId)
        return
      }
      case 'game': {
        const h = needHero()
        const tree = treeAt(a.loc, a.n)
        const P = `${a.loc}:${a.n}`
        const node = tree ? findNode(tree, a.id) : undefined
        if (!tree || !node) throw new GameError('Вариант не найден')
        const before = new Set(openNodes(tree, P, room.state.claimed).map((x) => x.id))
        const r = s.diceGame(h.uid, `${P}:${a.id}`)
        const head = `${h.name} играет в кости: ${r.mine} против ${r.theirs} — ${r.won ? 'выигрыш!' : r.mine === r.theirs ? 'ничья, а ничья за соперником.' : 'проигрыш.'}${r.applied ? ` ${r.applied}` : ''}`
        const opened = openNodes(tree, P, room.state.claimed).filter((x) => !before.has(x.id))
        if (opened.length) { this.sayNodes(room, a.loc, a.n, [head], opened, [], playerId); return }
        // ставка применена сразу: соперник, может быть, сыграет ещё
        const again = gamesPlayed(P, a.id, room.state.claimed ?? []) < gameLimit(node) ? [{ label: `🎲 Сыграть ещё раз${stakeLabel(node.hints!.game!)}`, action: { t: 'game', loc: a.loc, n: a.n, id: a.id } as ScriptAction }] : []
        this.say(room, head, again)
        return
      }
      case 'rewind': {
        // «Возврат времени»: отметка провала снимается, кнопка проверки или игры возвращается
        const tree = treeAt(a.loc, a.n)
        const P = `${a.loc}:${a.n}`
        const node = tree ? findNode(tree, a.id) : undefined
        if (!tree || !node || !hasResult(P, a.id, room.state.claimed ?? [], 'fail')) throw new GameError('Эту проверку уже не отыграть назад')
        s.unclaim(`${P}:${a.id}:fail`)
        if (node.hints?.game) s.unclaim((room.state.claimed ?? []).filter((k) => k.startsWith(`${P}:${a.id}:game#`)).at(-1) ?? '')
        this.say(room, 'Время возвращается назад.', fresh(room, nodeOffers(a.loc, a.n, node, room.state.claimed ?? [], new Set(openNodes(tree, P, room.state.claimed ?? []).map((x) => x.id)), room.state.heroes)))
        return
      }
      case 'penalty': {
        const h = room.state.heroes.find((x) => x.uid === a.heroUid)
        if (!h || h.status.dead) throw new GameError('Герой уже выбыл')
        const delta = a.kind === 'death' ? DEAD_AT - h.lives : a.kind === 'half' ? -Math.ceil(Math.max(0, h.lives) / 2) : -(a.amount ?? 0)
        s.adjustLives(h.uid, delta)
        this.say(room, a.kind === 'death' ? `${h.name} погибает.` : `${h.name} теряет ${-delta} ${plural(-delta, 'жизнь', 'жизни', 'жизней')}: осталось ${h.lives}.`)
        return
      }
      case 'fight': {
        // бой привязан к своему этапу (а не к последнему показанному параграфу: в пути их бывает несколько подряд);
        // его итог отметит сессия и откроет исходы этапа
        const at = a.loc && a.n !== undefined && a.id !== undefined ? `${a.loc}:${a.n}:${a.id}` : undefined
        s.startEncounter(a.specs, undefined, at)
        const loc = a.loc ?? room.script.locationId
        const n = a.n ?? room.script.n
        if (loc && n !== null && n !== undefined) room.script.fight = at ? { loc, n, id: a.id } : { loc, n }
        this.say(room, `Бой! Противники: ${room.state.combat?.monsters.map((m) => m.name).join(', ')}. Сражайтесь на экране боя.`)
        return
      }
      case 'coins': {
        const h = needHero()
        s.adjustMoney(h.uid, a.amount)
        this.say(room, `${h.name} забирает ${coinsWord(a.amount)}.`)
        return
      }
      case 'pay': {
        const h = needHero()
        s.adjustMoney(h.uid, -a.amount)
        this.say(room, `${h.name} платит ${coinsWord(a.amount)}.`)
        return
      }
      case 'buy': {
        const h = needHero()
        s.adjustMoney(h.uid, -a.price)
        for (const n of a.bottles) s.giveItem(h.uid, 'bottle', String(n), 1, false)
        this.say(room, `${h.name} платит ${coinsWord(a.price)} и получает ${a.bottles.length > 1 ? `${a.bottles.length} бутылки без этикеток` : 'бутылку без этикетки'}.`)
        return
      }
      case 'bottle': {
        const h = needHero()
        // ns — все бутылки находки; n и qty — кнопки из сохранений до 2026-10-20
        const ns = a.ns ?? Array<number>(a.qty ?? 1).fill(a.n ?? 0)
        for (const n of ns) s.giveItem(h.uid, 'bottle', String(n), 1, false)
        this.say(room, ns.length > 1 ? `${h.name} забирает ${ns.length} ${plural(ns.length, 'бутылку', 'бутылки', 'бутылок')} без этикеток.` : `${h.name} забирает бутылку без этикетки.`)
        return
      }
      case 'artifact': {
        const h = needHero()
        const n = s.findArtifact(h.uid)
        this.say(room, `${h.name} находит артефакт: ${n ? idx.artifact(n).name : '—'}. Все получают 500 очков опыта.`)
        return
      }
      case 'scroll': {
        const h = needHero()
        s.giveScroll(h.uid, a.caster, a.level)
        this.say(room, `${h.name} получает свиток.`)
        return
      }
      case 'rest':
        s.restAll(1)
        this.say(room, `Партия отдыхает сутки. День ${room.state.day}.`)
        return
      case 'next':
        this.say(room, room.state.locationId ? 'Куда дальше? Назовите номер помещения на плане.' : 'Куда дальше? Выберите путь на карте.')
        return
    }
  }
}
