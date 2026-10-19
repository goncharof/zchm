/**
 * Сценарный ведущий без ИИ: ведёт игру по разметке Книги Жизни (сцены, ветки, подсказки).
 * Показывает сцену параграфа и кнопки-варианты; выбранный вариант выполняет движком.
 * Работает как самостоятельный режим и как запасной ведущий, когда модели ИИ недоступны.
 */
import { randomUUID } from 'node:crypto'
import { idx } from '@/data'
import type { ParagraphHints, ParagraphSegment, SegmentBlock } from '@/types'
import { blockText, paragraphSegments, rollSides } from '@/game/book'
import type { Hero } from '@/engine/model'
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


/** Где в книге стоит кнопка (для проверок удачи — чтобы найти последствия и ветки-исходы) */
interface Place { loc: string; n: number; seg: number }


function segmentsAt(loc: string, n: number): ParagraphSegment[] {
  const p = idx.locationById.get(loc)?.paragraphs.find((x) => x.n === n)
  return p ? paragraphSegments(p) : []
}

/** Кнопки веток-исходов параграфа (разметка when: «Если выигрываете», «Если не удалось…» — tools/segment.py и правки) */
function outcomeOffers(loc: string, n: number, when: NonNullable<ParagraphSegment['when']>, skip?: number): Offer[] {
  return segmentsAt(loc, n).flatMap((g, i) =>
    g.kind === 'branch' && g.blocks.length && i !== skip && g.when === when ? [{ label: `▸ ${g.label}`, action: { t: 'branch', loc, n, seg: i } as ScriptAction }] : [])
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

/** Кнопки по подсказкам из текста. place — где в книге (для ключей одноразовых наград и привязки боя), tag — часть
 *  сегмента (сцена/ветка или исход броска), чтобы награды разных частей не путались */
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

function hintOffers(h: ParagraphHints | undefined, place?: Place, tag = 's', text = ''): Offer[] {
  if (!h) return []
  const out: Offer[] = []
  const sales = bottleSales(text, h)
  if (sales.length) h = { ...h, prices: [], bottles: [] }
  const once = (what: string) => (place ? `${place.loc}:${place.n}:${place.seg}:${tag}:${what}` : undefined)
  const fightable = (h.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special)
  if (fightable.length) {
    const specs = fightable.map((m) => ({ monsterId: m, count: h.monsterCounts?.[m] ?? 1 }))
    out.push({ label: `⚔ Бой: ${specs.map((s) => `${idx.monster(s.monsterId).name}${s.count > 1 ? ` ×${s.count}` : ''}`).join(', ')}`, action: { t: 'fight', specs, ...(place ? { loc: place.loc, n: place.n } : {}) } })
  }
  for (const t of h.luck ?? []) out.push({ label: `🎲 Проверка удачи ${t}`, action: { t: 'luck', target: t, ...place } })
  // покупка расходует запас торговца: по ключу на каждую бутылку, из них показывается первая не купленная (fresh)
  for (const sale of sales) {
    const what = sale.bottles.length > 1 ? `бутылки ${sale.bottles.map((n) => `(${n})`).join(', ')}` : `бутылку (${sale.bottles[0]})`
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
  // одинаковые бутылки — одной кнопкой («Взять 5 бутылок (4)»), раздать можно потом в разделе «Партия»
  const bottles = new Map<number, number>()
  for (const b of h.bottles ?? []) bottles.set(b, (bottles.get(b) ?? 0) + 1)
  for (const [b, qty] of bottles) out.push({ label: qty > 1 ? `Взять ${qty} ${plural(qty, 'бутылку', 'бутылки', 'бутылок')} (${b})` : `Взять бутылку (${b})`, action: { t: 'bottle', n: b, ...(qty > 1 ? { qty } : {}), once: once(`bottle:${b}`) } })
  if (h.artifact) out.push({ label: 'Взять артефакт', action: { t: 'artifact', once: once('artifact') } })
  ;(h.scrolls ?? []).forEach((s, i) => out.push({ label: `Взять свиток${s.level !== undefined ? ` ${s.level} ур.` : ''}`, action: { t: 'scroll', caster: s.caster, level: s.level, once: once(`scroll:${i}`) } }))
  if (h.tavern) out.push({ label: 'Отдохнуть сутки (2 монеты)', action: { t: 'rest' } })
  return out
}

function rollOffers(blocks: SegmentBlock[], loc: string, n: number, seg: number): Offer[] {
  const out: Offer[] = []
  blocks.forEach((b, i) => {
    if ('roll' in b) {
      const sides = rollSides(b.roll)
      // бросок по списку — один раз за параграф (иначе перебрасывали бы до награды); списки «для каждого» — сколько угодно
      out.push({ label: b.repeat ? `🎲 Бросить к${sides} (на каждый)` : `🎲 Бросить к${sides} по списку`, action: { t: 'roll', loc, n, seg, block: i, ...(b.repeat ? {} : { once: `${loc}:${n}:${seg}:roll:${i}` }) } })
    }
  })
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
/** Ответ сценарного ведущего на заклинание, которое движок не отыгрывает. «Чтение силы» в бою — характеристики
 *  противников (то, что игроки видят на экране боя, плюс храбрость и магия); остальное решают сами игроки. */
function spellReply(room: Room, spell: NonNullable<GmEvent['spell']>): string {
  const c = room.state.combat
  const foes = c && !c.finished ? c.monsters.filter((m) => !m.dead && !m.fled) : []
  if (spell.id === 'priest-chtenie-sily' && foes.length) {
    const lines = foes.map((m) => {
      const attacks = Array.isArray(m.attacks) ? `атаки ${m.attacks.join('-')}` : m.attacks === 'death' ? 'смертельная атака' : m.attacks === 'magic' ? 'бьёт только магией' : 'не атакует'
      const magic = m.spells?.length ? `магия: ${m.spells.join(', ')} (маны ${m.mana ?? 0})` : 'магией не владеет'
      return `• ${m.name}: уровень ${m.level}, защита ${m.defense + m.defenseMod}, жизни ${m.lives}/${m.maxLives}, ${attacks}, храбрость ${m.courage ?? 'нет'}; ${magic}.`
    })
    return [`${spell.hero} читает силу противников:`, ...lines].join('\n')
  }
  return `«${spell.name}»: сценарный ведущий такие заклинания не отыгрывает — исход решите сами по описанию заклинания (ИИ-ведущий, когда он доступен, разыграет его по тексту книги).`
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

  /** Герой, который действует за игрока: его первый живой герой, иначе первый живой в партии */
  private actor(room: Room, playerId?: string): Hero | undefined {
    const alive = room.state.heroes.filter((h) => !h.status.dead)
    const own = playerId ? room.players.get(playerId)?.heroUids ?? [] : []
    return alive.find((h) => own.includes(h.uid)) ?? alive[0]
  }

  /** Открыть параграф: сцена + кнопки */
  presentParagraph(room: Room, locId: string, n: number): void {
    const loc = idx.locationById.get(locId)
    const p = loc?.paragraphs.find((x) => x.n === n)
    if (!loc || !p) { this.say(room, `В «${loc?.name ?? locId}» нет помещения ${n}. Назовите номер с плана.`); return }
    const s = room.session()
    const before = (room.state.visited[loc.id] ?? []).includes(n)
    s.markVisited(loc.id, n)
    if (loc.id === 'doroga') s.dismissRoad(n)
    room.script = { ...room.script, locationId: loc.id, n }
    const head = loc.id === 'doroga' ? `В пути (§ ${n}).` : `${loc.name}, помещение ${n}${before ? ' (вы здесь уже были)' : ''}.`
    const segs = paragraphSegments(p)
    const scene = segs.filter((g) => g.kind === 'scene')
    const sceneText = scene.flatMap((g) => g.blocks.map(blockText)).join('\n')
    const offers: Offer[] = []
    segs.forEach((g, i) => {
      if (g.kind === 'scene') offers.push(...fresh(room, [...hintOffers(g.hints, { loc: loc.id, n, seg: i }, 's', g.blocks.map(blockText).join('\n')), ...rollOffers(g.blocks, loc.id, n, i)]))
      else if (!g.blocks.length) return
      else offers.push({ label: `▸ ${g.label}`, action: { t: 'branch', loc: loc.id, n, seg: i } })
    })
    const notes = segs.filter((g) => g.kind === 'branch' && !g.blocks.length).map((g) => g.label)
    offers.push({ label: 'Идти дальше', action: { t: 'next' } })
    this.say(room, [head, sceneText, ...notes.map((t) => `${t}.`)].filter(Boolean).join('\n\n'), offers)
    this.ctx.stateChanged(room)
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
        const f = room.script.fight
        delete room.script.fight
        const offers = f && ev.outcome ? outcomeOffers(f.loc, f.n, ev.outcome === 'victory' ? 'win' : 'lose') : []
        if (offers.length) this.say(room, `${ev.text} Что дальше по книге:`, [...offers, { label: 'Идти дальше', action: { t: 'next' } }])
        else this.say(room, `${ev.text} Продолжайте: выберите вариант выше или назовите номер следующего помещения.`)
      } else if (ev.type === 'spell' && ev.spell) {
        this.say(room, spellReply(room, ev.spell))
      } else if (ev.type === 'pass') {
        this.say(room, room.state.locationId ? 'Все готовы. Выберите вариант выше или назовите номер помещения на плане.' : 'Все готовы. Выберите путь на карте или войдите в локацию.')
      } else {
        this.say(room, ev.text)
      }
    }
    for (const t of texts) {
      const num = roomNumber(t.text)
      if (num !== null && room.state.locationId) this.presentParagraph(room, room.state.locationId, num)
      // в пути — только встречи, которые выпали партии
      else if (num !== null && room.state.pendingRoad.includes(num)) this.presentParagraph(room, 'doroga', num)
      else if (num !== null) this.say(room, room.state.pendingRoad.length ? `Встречи в пути: ${room.state.pendingRoad.map((x) => `§ ${x}`).join(', ')}.` : 'Сначала войдите в локацию с карты, потом назовите номер помещения.')
      else this.say(room, 'Сценарный ведущий понимает номера помещений на плане («помещение 5») и кнопки вариантов. Свободные реплики разбирает ИИ-ведущий, когда он доступен.')
    }
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
      case 'branch': {
        const seg = idx.locationById.get(a.loc)?.paragraphs.find((x) => x.n === a.n)?.segments?.[a.seg]
        if (!seg) throw new GameError('Вариант не найден')
        // в исходах боя упомянутые монстры убраны правками книги; новый противник после победы («2 орка бросаются») остаётся
        const offers = [...fresh(room, [...hintOffers(seg.hints, { loc: a.loc, n: a.n, seg: a.seg }, 's', seg.blocks.map(blockText).join('\n')), ...rollOffers(seg.blocks, a.loc, a.n, a.seg)]), { label: 'Идти дальше', action: { t: 'next' } as ScriptAction }]
        this.say(room, seg.blocks.map(blockText).join('\n'), offers)
        return
      }
      case 'roll': {
        const seg = idx.locationById.get(a.loc)?.paragraphs.find((x) => x.n === a.n)?.segments?.[a.seg]
        const block = seg?.blocks[a.block]
        if (!block || !('roll' in block)) throw new GameError('Список не найден')
        const sides = rollSides(block.roll)
        const r = s.rollDie(sides, 'Бросок по списку')
        const hit = block.roll.find((o) => o.values.includes(r))
        // награда исхода — своя у каждого варианта списка (в каждом доме деревни — своя), берётся один раз
        this.say(room, `Выпало ${r}: ${hit?.text ?? 'ничего не происходит'}`, hintOffers(hit?.hints, { loc: a.loc, n: a.n, seg: a.seg }, `r${a.block}.${hit ? block.roll.indexOf(hit) : 0}`, hit?.text))
        return
      }
      case 'luck': {
        const h = needHero()
        const r = s.luckCheck(h.uid, a.target)
        const head = `${h.name} испытывает удачу (${a.target}): к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} — ${r.ok ? 'удача!' : 'неудача.'}`
        if (a.loc === undefined || a.n === undefined) { this.say(room, head); return }
        // ветки-исходы этого параграфа и последствие провала из текста
        const offers = outcomeOffers(a.loc, a.n, r.ok ? 'luckOk' : 'luckFail', a.seg)
        const seg = a.seg !== undefined ? segmentsAt(a.loc, a.n)[a.seg] : undefined
        const text = seg ? [seg.kind === 'branch' ? seg.label : '', ...seg.blocks.map(blockText)].join(' ') : ''
        const pen = r.ok ? null : luckPenalty(text, a.target)
        if (pen) offers.unshift({ label: `Принять последствия: ${pen.text}`, action: { t: 'penalty', heroUid: h.uid, kind: pen.kind, amount: pen.amount } })
        this.say(room, pen ? `${head} По книге: иначе — ${pen.text}.` : head, offers)
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
        s.startEncounter(a.specs)
        // бой привязан к своему параграфу (а не к последнему показанному: в пути их бывает несколько подряд)
        const loc = a.loc ?? room.script.locationId
        const n = a.n ?? room.script.n
        if (loc && n !== null && n !== undefined) room.script.fight = { loc, n }
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
        const qty = a.qty ?? 1
        s.giveItem(h.uid, 'bottle', String(a.n), qty, false)
        this.say(room, qty > 1 ? `${h.name} забирает ${qty} ${plural(qty, 'бутылку', 'бутылки', 'бутылок')} без этикеток.` : `${h.name} забирает бутылку без этикетки.`)
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
