/**
 * Сценарный ведущий без ИИ: ведёт игру по дереву этапов Книги Жизни (src/game/tree.ts).
 * Показывает открытые этапы параграфа и их кнопки; выбранный вариант выполняет движком, исходы боя и проверок открывает сам.
 * Работает как самостоятельный режим и как запасной ведущий, когда модели ИИ недоступны.
 */
import { randomUUID } from 'node:crypto'
import { idx } from '@/data'
import type { BookNode, ParagraphHints } from '@/types'
import { allNodes, canFightHints, deadlyEffect, diceKey, effectLabel, findNode, gameLimit, gamesPlayed, hasResult, nodeFullText, nodeText, openChoices, openNodes, paragraphTree, parentOf, revealedBy, rollOf, stakeLabel } from '@/game/tree'
import type { Hero } from '@/engine/model'
import { hasWard, isConscious } from '@/engine/character'
import { UNDEAD } from '@/engine/combat'
import { GameError } from '@/game/session'
import { plural } from '@/ui/format'
import { DEAD_AT } from '@/engine/rules'
import type { ChatChoice, ChatMessage } from '@/net/protocol'
import type { Room, ScriptAction } from '../rooms'
import { castVote, resolveVote, voteComplete, votingOn } from '../votes'
import type { GmContext, GmEvent } from './types'

export const SCRIPT_AUTHOR = 'Ведущий · сценарий'

/** Короткие связки-атмосфера от ведущего (не текст книги): при первом входе в помещение локации и после боя. Выбор
 *  детерминированный (номер помещения и день), чтобы не трогать генератор случайностей */
const FLAVOR: Record<string, string[]> = {
  'zolotoy-gorod': ['Где-то вдали звенит колокол.', 'Под сапогами скрипит песок, нанесённый ветром с улиц.', 'Солнце играет на золочёных крышах.'],
  'krepost-rytsarey': ['На стенах висят выцветшие знамёна.', 'Эхо шагов гулко отдаётся под сводами.', 'Пахнет железом и конским потом.'],
  'zamok-chernogo-maga': ['Воздух здесь тяжёлый, факелы горят синим.', 'По спине пробегает холодок.', 'Тени на стенах шевелятся сами по себе.'],
  'zamok-zhretsov': ['Пахнет ладаном и старым воском.', 'Из-за стен доносится глухое пение.', 'Витражи бросают на пол цветные пятна.'],
  'mertvyy-gorod': ['Тишина такая, что слышно собственное сердце.', 'Ветер гонит по камням сухие листья.', 'Окна домов смотрят пустыми глазницами.'],
  'krepost-korolya-nazgulov': ['Со стен капает ледяная вода.', 'Тени здесь длиннее, чем должны быть.', 'Факел едва разгоняет мрак.'],
  'krepost-posledney-nadezhdy': ['Стены исцарапаны чьими-то когтями.', 'Сквозняк приносит запах гари.', 'Где-то наверху хлопает ставня.'],
  'chernye-peschery': ['Капли воды звонко падают в темноту.', 'Своды теряются во мраке, факел выхватывает лишь камень.', 'Под ногами хрустит каменная крошка.'],
  'runnoe-more': ['Волны бьют о камни, в воздухе соль и йод.', 'Над водой кричат чайки.', 'Доски скрипят под ногами.'],
  'liholese': ['Ветви смыкаются над головой, солнца почти не видно.', 'В чаще трещат сучья.', 'Мох глушит шаги.'],
  'drevnie-razvaliny': ['Из трещин в плитах пробивается трава.', 'Ветер свистит в проломах стен.', 'Резьба на колоннах стёрта временем.'],
  'broshennyy-gorod': ['Двери домов распахнуты, внутри темно.', 'На площади ржавеет перевёрнутая телега.', 'Ветер хлопает оторванной вывеской.'],
  'severnyy-fort': ['С севера тянет стужей.', 'На бойницах лежит снег.', 'Дыхание вырывается паром.'],
  'upokoische': ['Между могил стелется туман.', 'Где-то воет волк.', 'Кресты покосились, надписи не прочесть.'],
  'doroga': ['Дорога пылит под ногами.', 'Над полями кружат вороны.', 'Вдоль обочины тянутся старые межевые камни.'],
}
const FLAVOR_END: Record<'victory' | 'fled' | 'defeat', string[]> = {
  victory: ['Пыль оседает, звон стали смолкает.', 'Герои переводят дух и оглядываются.', 'Тишина после схватки кажется оглушительной.'],
  fled: ['Погоня отстаёт, дыхание понемногу выравнивается.', 'Крики за спиной стихают.', 'Лишь отбежав подальше, герои останавливаются.'],
  defeat: ['Темнота смыкается над полем боя.', 'Последнее, что слышно, — торжествующий рёв.', 'Силы оставляют героев.'],
}
const flavor = (lines: string[] | undefined, seed: number) => (lines?.length ? lines[Math.abs(seed) % lines.length] : '')

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

/** Служебные слова реплики, которые ничего не значат при сравнении с подписью кнопки */
const STOP = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'мы', 'я', 'к', 'ко', 'по', 'за', 'не', 'да', 'нет', 'его', 'их', 'ее', 'её', 'он', 'она', 'они', 'это', 'этот', 'эту', 'что', 'как', 'у', 'о', 'об', 'от', 'до', 'из', 'же', 'бы', 'ли', 'то', 'а', 'но', 'ну', 'вы', 'нас', 'нам', 'ему', 'ей', 'им', 'все', 'всё', 'тут', 'там', 'здесь', 'давай', 'давайте', 'хотим', 'хочу', 'пусть', 'если', 'сам', 'сами', 'свой', 'свою', 'герой', 'герои', 'партия', 'команда'])
const ENDINGS = /(иями|ями|ами|ием|ого|его|ому|ему|ыми|ими|ешь|ете|ите|ают|яют|ует|уют|ать|ять|ить|еть|ала|яла|ила|ела|ись|ось|ие|ые|ой|ей|ий|ый|ая|яя|ое|ее|ую|юю|ом|ем|ам|ям|ах|ях|ов|ев|ью|ия|ть|ся|сь|а|я|у|ю|ы|и|е|о|й|ь)$/

/** Основы слов реплики или подписи: строчные, без «ё», без служебных слов, с отрезанным окончанием (грубо, но для
 *  сравнения «освобождаем пленника» с «Если вы его освобождаете» хватает); числа остаются как есть */
export function stems(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w && !STOP.has(w)).map((w) => {
    if (/^\d+$/.test(w) || w.length < 4) return w
    const s = w.replace(ENDINGS, '')
    return s.length >= 3 ? s : w
  })
}
const sameStem = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))

/** Слова реплики, по которым угадывается вид кнопки, когда подпись сформулирована иначе («деремся» → «⚔ Бой») */
const INTENT: [RegExp, ScriptAction['t'][]][] = [
  [/дальш|ид[её]м|пошли|уход|выход|продолж|покида|дальн/, ['next']],
  [/отдых|спим|спать|ночу|ночев|переноч|трактир/, ['rest']],
  [/бой|дер[её]мся|бь[её]м|напад|атак|сража|руби|убив|убь[её]м|убить|драться|дра[кч]/, ['fight', 'duel']],
  [/удач|испыта|пробу|попроб|рискн/, ['luck', 'check']],
  [/кост|сыгра|игра/, ['game']],
  [/бер[её]м|взять|забир|забра|забер|подбир|подним|хвата|бер[иу]/, ['coins', 'bottle', 'artifact', 'item', 'scroll']],
  [/монет|деньг|золот/, ['coins']],
  [/бутыл|флакон|зель/, ['bottle', 'buy']],
  [/артефакт/, ['artifact']],
  [/свит/, ['scroll']],
  [/куп|покуп/, ['buy']],
  [/плат|заплат|отда[её]м|отдать|да[её]м\s+(?:ему|ей|им)/, ['pay']],
  [/отмыч|ключ|открыва|вскрыва|взлам/, ['pass']],
  [/фонтан|пь[её]м|выпь|выпить|напить/, ['fountain']],
  [/маг[аеу]?\b|чёрн|черн/, ['duel']],
]

/** Какая из кнопок последнего сообщения ведущего подходит под реплику. Сравниваются основы слов реплики и подписи,
 *  сверх того — слова-намерения по виду действия. Одна лучшая — она; несколько равных — уточнение (список);
 *  ни одной — null */
export function matchChoice(text: string, choices: { id: string; label: string; action: ScriptAction }[]): { pick?: string; among?: string[] } | null {
  const ts = stems(text)
  if (!ts.length) return null
  const kinds = new Set(INTENT.flatMap(([re, ks]) => (re.test(text.toLowerCase().replace(/ё/g, 'е')) ? ks : [])))
  const scored = choices.map((c) => {
    const ls = stems(c.label.replace(/^[▸⚔🎲🗝⏪👁👍👎]\s*/u, ''))
    const overlap = ls.filter((l) => ts.some((t) => sameStem(t, l))).length
    const kind = kinds.has(c.action.t) ? 1 : 0
    // «Идти дальше» только по слову-намерению: его основа совпадает со многими репликами
    return { id: c.id, score: c.action.t === 'next' ? kind : overlap + kind }
  }).filter((x) => x.score > 0)
  if (!scored.length) return null
  const top = Math.max(...scored.map((x) => x.score))
  const best = scored.filter((x) => x.score === top)
  return best.length === 1 ? { pick: best[0].id } : { among: best.map((x) => x.id) }
}

/** Вопрос о положении партии: сводка вместо кнопок */
const WHERE = /где (?:мы|партия|наход)|куда (?:дальше|идти|пойти|теперь)|что (?:дальше|теперь|осталось)|статус|сводк|что не пройден|какие помещения/i
/** Вопрос: знак вопроса или вопросительное слово в начале */
const QUESTION = /\?\s*$|^\s*(?:что|кто|где|куда|как|почему|зачем|сколько|можно ли|есть ли|какой|какая|какие|какое|чем|откуда|правда ли)(?![а-яё])/i
const QUESTION_WORDS = new Set(['что', 'кто', 'где', 'куда', 'как', 'почему', 'зачем', 'сколько', 'можно', 'есть', 'какой', 'какая', 'какие', 'какое', 'чем', 'откуда', 'правда', 'ли', 'это', 'такое', 'значит', 'видим', 'вид', 'тут', 'там'])

/** Список номеров словами: «3, 5–9, 12» */
export function ranges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : j > i ? `${sorted[i]}, ${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return out.join(', ')
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
    // связка-атмосфера при первом входе — от ведущего, не из книги
    const mood = before ? '' : flavor(FLAVOR[loc.id], n + room.state.day)
    const nodes = openNodes(paragraphTree(p), `${loc.id}:${n}`, room.state.claimed)
    this.sayNodes(room, loc.id, n, [mood ? `${head} ${mood}` : head], nodes, [], playerId, !before)
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
    // по книге монстры нападают сами: бой начнётся без кнопки (если другой бой не идёт)
    const ambush = this.ambushIn(room, P, nodes)
    const fromNodes = fresh(room, nodes.flatMap((x) => nodeOffers(loc, n, x, claimed, open, room.state.heroes))).filter((o) => !(ambush && o.action.t === 'fight' && o.action.id === ambush.id))
    offers.push(...fromNodes, { label: 'Идти дальше', action: { t: 'next' } as ScriptAction })
    this.say(room, [...head, ...text].filter(Boolean).join('\n\n'), offers)
    if (ambush) this.startAmbush(room, loc, n, ambush, playerId)
    // «летит в центр города (локация 41)» — партия переходит в названное помещение
    const to = jump ? nodes.find((x) => x.goto !== undefined)?.goto : undefined
    if (to !== undefined && to !== n) this.presentParagraph(room, loc, to, playerId)
  }

  /** Этап среди показанных, где монстры нападают сами (hints.attack) и бой ещё не выигран; пока идёт другой бой — нет */
  private ambushIn(room: Room, P: string, nodes: BookNode[]): BookNode | undefined {
    if (room.state.combat && !room.state.combat.finished) return undefined
    return nodes.find((x) => x.hints?.attack && canFightHints(x.hints) && !hasResult(P, x.id, room.state.claimed ?? [], 'won'))
  }

  /** Начать бой нападающего этапа сам, как сделал бы живой ведущий */
  private startAmbush(room: Room, loc: string, n: number, node: BookNode, playerId?: string): void {
    const h = node.hints!
    const specs = (h.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special).map((monsterId) => ({ monsterId, count: h.monsterCounts?.[monsterId] ?? 1 }))
    try { this.apply(room, playerId ?? '', { t: 'fight', specs, loc, n, id: node.id, ambush: true }) } catch (e) {
      if (!(e instanceof GameError) && !(e instanceof Error && e.name === 'GameError')) throw e
      this.say(room, (e as Error).message)
    }
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
        const mood = ev.outcome ? flavor(FLAVOR_END[ev.outcome], room.state.day + (f?.n ?? 0)) : ''
        if (f && shownNodes.length) this.sayNodes(room, f.loc, f.n, [`${ev.text} ${mood}`.trim()], shownNodes)
        else this.say(room, `${ev.text} ${mood} Продолжайте: выберите вариант выше или назовите номер следующего помещения.`.replace(/\s+/g, ' '))
      } else if (ev.type === 'spell' && ev.spell) {
        const r = spellReply(room, ev.spell)
        this.say(room, r.text, r.offers ?? [])
      } else if (ev.type === 'pass') {
        this.say(room, room.state.locationId ? 'Все готовы. Выберите вариант выше или назовите номер помещения на плане.' : 'Все готовы. Выберите путь на карте или войдите в локацию.')
      } else {
        this.say(room, ev.text)
      }
    }
    const unmatched: { author: string; text: string }[] = []
    for (const t of texts) {
      // разведка заклинанием ждёт номера помещений: «зло 7, 12», «разведка 5»
      const sense = room.script.sense && t.text.match(/^\s*(?:зло|чу[юя]|чувств\S*|разведк\S*|тень|душ\S*)(?![а-яё])[^\d]*(\d[\d\s,и]*)/i)
      if (sense) { this.say(room, senseReply(room, [...new Set(sense[1].match(/\d+/g)!.map(Number))])); continue }
      const num = roomNumber(t.text)
      if (num !== null && room.state.locationId) this.presentParagraph(room, room.state.locationId, num, t.playerId)
      // в пути — только встречи, которые выпали партии
      else if (num !== null && room.state.pendingRoad.includes(num)) this.presentParagraph(room, 'doroga', num, t.playerId)
      else if (num !== null) this.say(room, room.state.pendingRoad.length ? `Встречи в пути: ${room.state.pendingRoad.map((x) => `§ ${x}`).join(', ')}.` : 'Сначала войдите в локацию с карты, потом назовите номер помещения.')
      else if (!this.freeReply(room, t.text, t.playerId)) unmatched.push(t)
    }
    if (unmatched.length) this.tableDecision(room, unmatched)
    this.remind(room)
    // этапы, открытые событием (исход боя), могли изменить состояние: последствия, спутник
    this.ctx.stateChanged(room)
  }

  /** Кнопки последнего сообщения ведущего, которые ещё не нажаты */
  private openChoices(room: Room): { msg: ChatMessage; id: string; label: string; action: ScriptAction }[] {
    const msg = [...room.chat].reverse().find((m) => m.from === 'gm' && m.choices?.some((c) => !m.used?.includes(c.id) && room.choiceActions[c.id]))
    if (!msg) return []
    return msg.choices!.filter((c) => !msg.used?.includes(c.id) && room.choiceActions[c.id]).map((c) => ({ msg, id: c.id, label: c.label, action: room.choiceActions[c.id].action }))
  }

  /** Где партия и что здесь не доделано: непройденные помещения, невыбранные варианты, незаконченный бой, состояние героев */
  private whereReply(room: Room): string {
    const s = room.state
    const lines: string[] = []
    const loc = s.locationId ? idx.locationById.get(s.locationId) : null
    if (loc) {
      const visited = new Set(s.visited[loc.id] ?? [])
      const left = loc.paragraphs.map((p) => p.n).filter((x) => !visited.has(x))
      lines.push(`Вы в локации «${loc.name}»${room.script.n != null ? `, помещение ${room.script.n}` : ''}, день ${s.day}. Пройдено ${visited.size} из ${loc.paragraphs.length}${left.length ? `, не пройдены: ${ranges(left)}` : ', все помещения пройдены'}.`)
      if (room.script.n != null) {
        const P = `${loc.id}:${room.script.n}`
        const tree = treeAt(loc.id, room.script.n)
        const claimed = s.claimed ?? []
        const choices = tree ? openChoices(tree, P, claimed) : []
        const fights = tree ? openNodes(tree, P, claimed).filter((x) => canFightHints(x.hints) && !hasResult(P, x.id, claimed, 'won')) : []
        if (choices.length) lines.push(`Здесь ещё не выбрано: ${choices.map((c) => `«${shown(c.label ?? '')}»`).join(', ')}.`)
        if (fights.length) lines.push(`Не выигран бой: ${fights.flatMap((x) => (x.hints!.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special).map((m) => idx.monster(m).name)).join(', ')}.`)
      }
    } else {
      const node = room.world?.nodes.find((x) => x.id === s.worldNodeId)
      lines.push(`Партия на карте: ${node?.name ?? '—'}, день ${s.day}.${s.pendingRoad.length ? ` Встречи в пути: ${s.pendingRoad.map((x) => `§ ${x}`).join(', ')}.` : ' Войдите в локацию или выберите путь на карте.'}`)
    }
    if (s.combat && !s.combat.finished) lines.push('Идёт бой — на экране боя.')
    lines.push(...this.reminders(room))
    return lines.join('\n')
  }

  /** Напоминания-рефери: что по правилам назрело у героев и спутников */
  private reminders(room: Room): string[] {
    const out: string[] = []
    for (const h of room.state.heroes) {
      if (h.status.dead) { out.push(`${h.name} погиб: заменить героя можно на экране «Партия».`); continue }
      if (h.status.unconscious) out.push(`${h.name} без сознания: нужны лечение, бутылка или отдых.`)
      else if (h.lives <= Math.max(3, Math.floor(h.maxLives / 4))) out.push(`${h.name} при смерти (${h.lives} из ${h.maxLives}): лечение, бутылка или трактир.`)
      if (h.status.poison) out.push(`${h.name} отравлен: противоядие или «Исцеление».`)
      if (h.pendingSpellPicks > 0) out.push(`${h.name}: не выбрано заклинание за новый уровень (${h.pendingSpellPicks}) — экран героя.`)
    }
    for (const c of room.state.companions) if (c.battlesLeft === 1) out.push(`${c.name} остаётся с партией на один бой.`)
    return out
  }

  /** Напоминания после хода — только вне боя и только когда они изменились */
  private remind(room: Room): void {
    if (room.state.combat && !room.state.combat.finished) return
    const text = this.reminders(room).join('\n')
    if (text === (room.script.reminded ?? '')) return
    room.script = { ...room.script, reminded: text }
    // системное сообщение, а не реплика ведущего: не заслоняет сцену и кнопки
    if (text) this.ctx.chat(room, { from: 'system', author: 'Напоминание', text })
  }

  /** Ответ на вопрос по сцене: фразы открытых этапов, в которых есть слова вопроса; иначе — честное «в книге нет» */
  private answerFromScene(room: Room, question: string): string {
    const loc = room.script.locationId
    const n = room.script.n
    if (!loc || n == null) return 'Партия не в помещении: назовите номер на плане или выберите путь на карте.'
    const tree = treeAt(loc, n)
    const qs = stems(question.replace(/\?/g, ' ')).filter((w) => !QUESTION_WORDS.has(w))
    const sentences = (tree ? openNodes(tree, `${loc}:${n}`, room.state.claimed ?? []) : []).flatMap((x) => shown(nodeText(x)).split(/(?<=[.!?…])\s+/)).filter((x) => x.trim())
    const scored = sentences.map((sent) => ({ sent, score: stems(sent).filter((l) => qs.some((q) => sameStem(q, l))).length })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
    if (!scored.length) return 'В книге об этом ничего нет — решайте по смыслу или спросите иначе.'
    return `По книге: «${scored.slice(0, 2).map((x) => x.sent.trim()).join(' ')}»`
  }

  /** Свободная реплика: «где мы» — сводка, «осмотреться» — сцена заново, вопрос — ответ по тексту сцены; иначе подходящая
   *  кнопка нажимается от имени игрока (в режиме «когда все готовы» — голос за неё). Несколько подходящих — уточнение.
   *  Ничего не подошло — false */
  private freeReply(room: Room, text: string, playerId?: string): boolean {
    const loc = room.script.locationId
    if (WHERE.test(text)) { this.say(room, this.whereReply(room)); return true }
    if (/осмотр|огляд|смотр|обыск|ищем|ищу|поищ|разгляд|изуча/i.test(text) && loc && room.script.n != null) {
      this.presentParagraph(room, loc, room.script.n, playerId)
      return true
    }
    if (QUESTION.test(text)) { this.say(room, this.answerFromScene(room, text)); return true }
    const choices = this.openChoices(room)
    const m = matchChoice(text, choices)
    if (!m) return false
    if (m.among) {
      const among = choices.filter((c) => m.among!.includes(c.id))
      this.say(room, 'Уточните, что именно:', among.map((c) => ({ label: c.label, action: c.action })))
      return true
    }
    const c = choices.find((x) => x.id === m.pick)!
    if (!playerId) return false
    if (votingOn(room)) {
      this.ctx.updateChat(room, castVote(room, playerId, c.msg.id, c.id))
      if (voteComplete(room, c.msg.id)) resolveVote(room, c.msg.id, this.ctx, (p, mid, cid) => this.choose(room, p, mid, cid))
    } else this.choose(room, playerId, c.msg.id, c.id)
    return true
  }

  /** Действия, которых в книге нет, решает стол: проверка удачи, кубик, да или нет — как у живого ведущего */
  private tableDecision(room: Room, texts: { author: string; text: string }[]): void {
    const what = texts.map((t) => `${t.author}: «${t.text.slice(0, 120)}»`).join('; ')
    const offers: Offer[] = [
      ...[8, 12, 16].map((target) => ({ label: `🎲 Проверка удачи ${target}${target === 8 ? ' (легко)' : target === 16 ? ' (трудно)' : ''}`, action: { t: 'check', target } as ScriptAction })),
      { label: '🎲 Бросить к6', action: { t: 'die', sides: 6 } },
      { label: '👍 Стол решает: да', action: { t: 'decide', yes: true } },
      { label: '👎 Стол решает: нет', action: { t: 'decide', yes: false } },
      ...(room.script.locationId && room.script.n != null ? [{ label: '👁 Осмотреться', action: { t: 'look' } as ScriptAction }] : []),
      { label: '🧭 Где мы', action: { t: 'where' } },
    ]
    this.say(room, `${what} — в книге такого действия нет. Решите за столом, как с живым ведущим: удача, кубик или общее решение; номер помещения на плане открывает его, кнопки выше — варианты книги.`, offers)
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
          const ambush = hit ? this.ambushIn(room, P, [hit]) : undefined
          this.say(room, `Выпало ${r}: ${hit ? shown(nodeText(hit) || hit.label || '') : 'ничего не происходит'}`, hit ? fresh(room, nodeOffers(a.loc, a.n, hit, room.state.claimed ?? [], new Set(), room.state.heroes)).filter((o) => !(ambush && o.action.t === 'fight')) : [])
          if (ambush) this.startAmbush(room, a.loc, a.n, ambush, playerId)
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
        this.say(room, `${a.ambush ? 'Нападение! ' : 'Бой! '}Противники: ${room.state.combat?.monsters.map((m) => m.name).join(', ')}. Сражайтесь на экране боя.`)
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
      case 'check': {
        const h = needHero()
        const r = s.luckCheck(h.uid, a.target)
        this.say(room, `${h.name} испытывает удачу (${a.target}): к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} — ${r.ok ? 'удача!' : 'неудача.'} Что это значит, решите по смыслу.`)
        return
      }
      case 'die': {
        const r = s.rollDie(a.sides, 'Решение стола')
        this.say(room, `Кубик к${a.sides}: выпало ${r}.`)
        return
      }
      case 'decide':
        this.say(room, `Стол решает: ${a.yes ? 'да' : 'нет'} (${room.players.get(playerId)?.name ?? 'игрок'}).`)
        return
      case 'look':
        if (room.script.locationId && room.script.n != null) this.presentParagraph(room, room.script.locationId, room.script.n, playerId)
        else this.say(room, 'Партия не в помещении: назовите номер на плане или выберите путь на карте.')
        return
      case 'where':
        this.say(room, this.whereReply(room))
        return
    }
  }
}
