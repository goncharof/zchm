/**
 * Сценарный ведущий без ИИ: ведёт игру по разметке Книги Жизни (сцены, ветки, подсказки).
 * Показывает сцену параграфа и кнопки-варианты; выбранный вариант выполняет движком.
 * Работает как самостоятельный режим и как запасной ведущий, когда модели ИИ недоступны.
 */
import { randomUUID } from 'node:crypto'
import { idx } from '@/data'
import type { Paragraph, ParagraphHints, ParagraphSegment, SegmentBlock } from '@/types'
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

function blockText(b: SegmentBlock): string {
  return 'text' in b ? b.text : b.roll.map((o) => `${o.values.join(', ')} — ${o.text}`).join('\n')
}

/** Где в книге стоит кнопка (для проверок удачи — чтобы найти последствия и ветки-исходы) */
interface Place { loc: string; n: number; seg: number }

/** Ветки-исходы по формулировке: «Если выигрываете», «Проигрываете», «Если не удалось…» */
const WIN = /побежда|выигр|убива|победител|одолева/i
const LOSE = /проигр|поражени/i
const LUCK_FAIL = /не\s+(удал|успел|откинут|смогл|получил)/i
const LUCK_OK = /(^|[^е]\s)(удалось|успели|смогли)/i

/** Сегменты параграфа; неразмеченный параграф — одна сцена */
function segmentsOf(p: Paragraph): ParagraphSegment[] {
  return p.segments ?? [{ kind: 'scene', blocks: [{ text: p.text }], hints: p.hints }]
}

function paragraphSegments(loc: string, n: number): ParagraphSegment[] {
  const p = idx.locationById.get(loc)?.paragraphs.find((x) => x.n === n)
  return p ? segmentsOf(p) : []
}

/** Кнопки веток параграфа, чья формулировка подходит под исход */
function outcomeOffers(loc: string, n: number, test: RegExp, skip?: number): Offer[] {
  return paragraphSegments(loc, n).flatMap((g, i) =>
    g.kind === 'branch' && g.blocks.length && i !== skip && test.test(g.label ?? "") ? [{ label: `▸ ${g.label}`, action: { t: 'branch', loc, n, seg: i } as ScriptAction }] : [])
}

export interface LuckPenalty { kind: 'death' | 'lives' | 'half'; amount?: number; text: string }

/** Последствие провала из текста: «удача — 6, иначе смерть», «Удача — 14, иначе — -2 жизни», «иначе половина жизней исчезает» */
export function luckPenalty(text: string, target: number): LuckPenalty | null {
  const m = new RegExp(`удач[аеи]\\s*[—–-]?\\s*${target}(?!\\d)[^.]{0,20}?иначе\\s*[—–-]?\\s*(смерть|[-−–]?\\s*(\\d+)\\s*жизн\\S*|половина жизней)`, 'i').exec(text)
  if (!m) return null
  if (/смерть/i.test(m[1])) return { kind: 'death', text: 'смерть' }
  if (/половина/i.test(m[1])) return { kind: 'half', text: 'половина жизней' }
  const amount = Number(m[2])
  return { kind: 'lives', amount, text: `−${amount} ${plural(amount, 'жизнь', 'жизни', 'жизней')}` }
}

/** Кнопки по подсказкам из текста */
function hintOffers(h: ParagraphHints | undefined, place?: Place): Offer[] {
  if (!h) return []
  const out: Offer[] = []
  const fightable = (h.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special)
  if (fightable.length) {
    const specs = fightable.map((m) => ({ monsterId: m, count: h.monsterCounts?.[m] ?? 1 }))
    out.push({ label: `⚔ Бой: ${specs.map((s) => `${idx.monster(s.monsterId).name}${s.count > 1 ? ` ×${s.count}` : ''}`).join(', ')}`, action: { t: 'fight', specs } })
  }
  for (const t of h.luck ?? []) out.push({ label: `🎲 Проверка удачи ${t}`, action: { t: 'luck', target: t, ...place } })
  for (const c of h.prices ?? []) out.push({ label: `Заплатить ${c} монет`, action: { t: 'pay', amount: c } })
  for (const c of h.coins ?? []) out.push({ label: `Забрать ${c} монет`, action: { t: 'coins', amount: c } })
  for (const b of h.bottles ?? []) out.push({ label: `Взять бутылку (${b})`, action: { t: 'bottle', n: b } })
  if (h.artifact) out.push({ label: 'Взять артефакт', action: { t: 'artifact' } })
  for (const s of h.scrolls ?? []) out.push({ label: `Взять свиток${s.level !== undefined ? ` ${s.level} ур.` : ''}`, action: { t: 'scroll', caster: s.caster, level: s.level } })
  if (h.tavern) out.push({ label: 'Отдохнуть сутки (2 монеты)', action: { t: 'rest' } })
  return out
}

function rollOffers(blocks: SegmentBlock[], loc: string, n: number, seg: number): Offer[] {
  const out: Offer[] = []
  blocks.forEach((b, i) => {
    if ('roll' in b) {
      const sides = Math.max(...b.roll.flatMap((o) => o.values)) > 6 ? 18 : 6
      out.push({ label: `🎲 Бросить к${sides} по списку`, action: { t: 'roll', loc, n, seg, block: i } })
    }
  })
  return out
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
    room.script = { locationId: loc.id, n }
    const head = loc.id === 'doroga' ? `В пути (§ ${n}).` : `${loc.name}, помещение ${n}${before ? ' (вы здесь уже были)' : ''}.`
    const segs = segmentsOf(p)
    const scene = segs.filter((g) => g.kind === 'scene')
    const sceneText = scene.flatMap((g) => g.blocks.map(blockText)).join('\n')
    const offers: Offer[] = []
    segs.forEach((g, i) => {
      if (g.kind === 'scene') offers.push(...hintOffers(g.hints, { loc: loc.id, n, seg: i }), ...rollOffers(g.blocks, loc.id, n, i))
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
        this.say(room, `${ev.text}${enc.length ? '' : ' Куда дальше? Войдите в локацию с карты.'}`)
        for (const n of enc) this.presentParagraph(room, 'doroga', n)
      } else if (ev.type === 'enter') {
        const loc = room.state.locationId ? idx.locationById.get(room.state.locationId) : null
        room.script = { locationId: loc?.id ?? null, n: null }
        this.say(room, `Вы входите: «${loc?.name ?? ''}». Назовите номер помещения или нажмите его на плане.`)
      } else if (ev.type === 'combatEnd') {
        const f = room.script.fight
        delete room.script.fight
        const offers = f && ev.outcome ? outcomeOffers(f.loc, f.n, ev.outcome === 'victory' ? WIN : LOSE) : []
        if (offers.length) this.say(room, `${ev.text} Что дальше по книге:`, [...offers, { label: 'Идти дальше', action: { t: 'next' } }])
        else this.say(room, `${ev.text} Продолжайте: выберите вариант выше или назовите номер следующего помещения.`)
      } else {
        this.say(room, ev.text)
      }
    }
    for (const t of texts) {
      const num = t.text.match(/(\d{1,3})/)?.[1]
      const locId = room.state.locationId ?? (room.state.pendingRoad.length ? 'doroga' : null)
      if (num && locId) this.presentParagraph(room, locId, Number(num))
      else if (num) this.say(room, 'Сначала войдите в локацию с карты, потом назовите номер помещения.')
      else this.say(room, 'Сценарный ведущий понимает номера помещений на плане и кнопки вариантов. Свободные реплики разбирает ИИ-ведущий, когда он доступен.')
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
    this.ctx.chat(room, { from: 'player', author: who, text: `Выбор: ${label.replace(/^[▸⚔🎲]\s*/u, '')}`, toGm: true })
    try {
      this.apply(room, playerId, rec.action)
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
        const offers = [...hintOffers(seg.hints, { loc: a.loc, n: a.n, seg: a.seg }), ...rollOffers(seg.blocks, a.loc, a.n, a.seg), { label: 'Идти дальше', action: { t: 'next' } as ScriptAction }]
        this.say(room, seg.blocks.map(blockText).join('\n'), offers)
        return
      }
      case 'roll': {
        const seg = idx.locationById.get(a.loc)?.paragraphs.find((x) => x.n === a.n)?.segments?.[a.seg]
        const block = seg?.blocks[a.block]
        if (!block || !('roll' in block)) throw new GameError('Список не найден')
        const sides = Math.max(...block.roll.flatMap((o) => o.values)) > 6 ? 18 : 6
        const r = s.rollDie(sides, 'Бросок по списку')
        const hit = block.roll.find((o) => o.values.includes(r))
        this.say(room, `Выпало ${r}: ${hit?.text ?? 'ничего не происходит'}`, hintOffers(hit?.hints))
        return
      }
      case 'luck': {
        const h = needHero()
        const r = s.luckCheck(h.uid, a.target)
        const head = `${h.name} испытывает удачу (${a.target}): к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} — ${r.ok ? 'удача!' : 'неудача.'}`
        if (a.loc === undefined || a.n === undefined) { this.say(room, head); return }
        // ветки-исходы этого параграфа и последствие провала из текста
        const offers = outcomeOffers(a.loc, a.n, r.ok ? LUCK_OK : LUCK_FAIL, a.seg)
        const seg = a.seg !== undefined ? paragraphSegments(a.loc, a.n)[a.seg] : undefined
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
      case 'fight':
        if (room.script.locationId && room.script.n !== null) room.script.fight = { loc: room.script.locationId, n: room.script.n }
        s.startEncounter(a.specs)
        this.say(room, `Бой! Противники: ${room.state.combat?.monsters.map((m) => m.name).join(', ')}. Сражайтесь на экране боя.`)
        return
      case 'coins': {
        const h = needHero()
        s.adjustMoney(h.uid, a.amount)
        this.say(room, `${h.name} забирает ${a.amount} монет.`)
        return
      }
      case 'pay': {
        const h = needHero()
        s.adjustMoney(h.uid, -a.amount)
        this.say(room, `${h.name} платит ${a.amount} монет.`)
        return
      }
      case 'bottle': {
        const h = needHero()
        s.giveItem(h.uid, 'bottle', String(a.n), 1, false)
        this.say(room, `${h.name} забирает бутылку без этикетки.`)
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
