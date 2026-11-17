/** Инструменты ИИ-ведущего: схемы для Claude API и исполнение через GameSession. */
import type Anthropic from '@anthropic-ai/sdk'
import { paragraphTree } from '@/game/tree'
import { z } from 'zod'
import { idx } from '@/data'
import type { Hero } from '@/engine/model'
import type { BookNode, ParagraphHints } from '@/types'
import { GameError, MAX_FOES } from '@/game/session'
import type { Room } from '../rooms'

type Tool = Anthropic.Beta.BetaTool

const heroProp = { type: 'string', description: 'Имя героя или его uid из «Состояния партии».' }

/** Определения инструментов (порядок фиксирован — от него зависит кэш) */
export const GM_TOOLS: Tool[] = ([
  {
    name: 'open_paragraph',
    description: 'Прочитать параграф Книги Жизни (этапы: что видно сразу, что открывается по выбору, после боя или проверки удачи, тайные пометки, подсказки) и отметить его пройденным. Вызывай, когда партия входит в помещение локации или с ней случается встреча в пути (location_id "doroga").',
    input_schema: { type: 'object', properties: { location_id: { type: 'string', description: 'id локации из списка' }, n: { type: 'integer', description: 'номер параграфа' } }, required: ['location_id', 'n'], additionalProperties: false },
  },
  {
    name: 'roll_luck',
    description: 'Бросок удачи героя: к18 + удача ≥ target. Используй для проверок «удача — N» из текста.',
    input_schema: { type: 'object', properties: { hero: heroProp, target: { type: 'integer', description: 'порог N' } }, required: ['hero', 'target'], additionalProperties: false },
  },
  {
    name: 'roll_dice',
    description: 'Бросить кубики по формуле («1к6», «2к6+2», «1к18»). Для выбора по таблицам из текста и случайных событий.',
    input_schema: { type: 'object', properties: { formula: { type: 'string' } }, required: ['formula'], additionalProperties: false },
  },
  {
    name: 'start_combat',
    description: 'Начать бой с монстрами из Бестиария (id или имя монстра, число — как в тексте). Дальше игроки сражаются в интерфейсе боя; закончи реплику.',
    input_schema: { type: 'object', properties: { monsters: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, count: { type: 'integer' } }, required: ['id', 'count'], additionalProperties: false } } }, required: ['monsters'], additionalProperties: false },
  },
  {
    name: 'change_lives',
    description: 'Изменить жизни героя (урон или лечение из текста параграфа). delta < 0 — урон.',
    input_schema: { type: 'object', properties: { hero: heroProp, delta: { type: 'integer' }, reason: { type: 'string' } }, required: ['hero', 'delta', 'reason'], additionalProperties: false },
  },
  {
    name: 'change_money',
    description: 'Дать или забрать монеты (находка, плата, награда из текста). delta < 0 — плата; если монет не хватает, придёт ошибка.',
    input_schema: { type: 'object', properties: { hero: heroProp, delta: { type: 'integer' }, reason: { type: 'string' } }, required: ['hero', 'delta', 'reason'], additionalProperties: false },
  },
  {
    name: 'give_item',
    description: 'Дать герою предмет: kind "bottle" и ref "1"…"6" — бутылка из текста (неопознанная); "weapon"/"armor"/"item" — id из лавки (например "mech-korotkiy", "kozhanyy-dospeh", "protivoyadie").',
    input_schema: { type: 'object', properties: { hero: heroProp, kind: { type: 'string', enum: ['bottle', 'weapon', 'armor', 'item'] }, ref: { type: 'string' }, qty: { type: 'integer' } }, required: ['hero', 'kind', 'ref', 'qty'], additionalProperties: false },
  },
  {
    name: 'give_artifact',
    description: 'Герой находит артефакт (к18 определяет какой; все получают 500 опыта). Только если артефакт есть в тексте.',
    input_schema: { type: 'object', properties: { hero: heroProp }, required: ['hero'], additionalProperties: false },
  },
  {
    name: 'give_scroll',
    description: 'Герой получает свиток с заклинанием. caster и level — как в тексте («свиток с заклинанием мага 5 уровня»), иначе null.',
    input_schema: { type: 'object', properties: { hero: heroProp, caster: { type: ['string', 'null'], enum: ['mage', 'priest', null] }, level: { type: ['integer', 'null'] } }, required: ['hero', 'caster', 'level'], additionalProperties: false },
  },
  {
    name: 'give_xp',
    description: 'Начислить опыт вне боя (найденная ловушка или тайник — 400 вору, разгаданная загадка и т.п.).',
    input_schema: { type: 'object', properties: { hero: heroProp, amount: { type: 'integer' }, reason: { type: 'string' } }, required: ['hero', 'amount', 'reason'], additionalProperties: false },
  },
  {
    name: 'add_companion',
    description: 'Существо из текста присоединяется к партии как спутник на battles боёв (рыцарь — 3 боя, наёмники — сколько оплачено). Засчитываются только выигранные бои.',
    input_schema: { type: 'object', properties: { monster_id: { type: 'string' }, battles: { type: 'integer' } }, required: ['monster_id', 'battles'], additionalProperties: false },
  },
  {
    name: 'rest',
    description: 'Отдых в трактире на days суток (2 монеты в сутки с героя, +5 жизней и маны в сутки).',
    input_schema: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'], additionalProperties: false },
  },
  {
    name: 'final_duel_attack',
    description: 'Финал в Замке Чёрного мага (§13): герой пытается поразить мага (удача 15; при промахе маг бросает огненный шар). Попадание — победа.',
    input_schema: { type: 'object', properties: { hero: heroProp }, required: ['hero'], additionalProperties: false },
  },
  {
    name: 'drink_fountain',
    description: 'Партия пьёт из фонтана, если она у него: в зале Чёрного мага (Замок, §13) восстанавливаются все жизни и мана, в Крепости короля назгулов (§22) — +5 жизней. Из одного фонтана — раз в день.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
] as Tool[]).map((t) => ({ ...t, strict: true, eager_input_streaming: true }))

const Hero = z.string().min(1).max(60)
const SCHEMAS = {
  open_paragraph: z.object({ location_id: z.string(), n: z.number().int() }),
  roll_luck: z.object({ hero: Hero, target: z.number().int().min(1).max(40) }),
  roll_dice: z.object({ formula: z.string().max(20) }),
  start_combat: z.object({ monsters: z.array(z.object({ id: z.string(), count: z.number().int().min(1).max(MAX_FOES) })).min(1).max(8) }),
  change_lives: z.object({ hero: Hero, delta: z.number().int().min(-100).max(100), reason: z.string().max(200).optional() }),
  change_money: z.object({ hero: Hero, delta: z.number().int().min(-5000).max(5000), reason: z.string().max(200).optional() }),
  give_item: z.object({ hero: Hero, kind: z.enum(['bottle', 'weapon', 'armor', 'item']), ref: z.string().max(60), qty: z.number().int().min(1).max(50).default(1) }),
  give_artifact: z.object({ hero: Hero }),
  give_scroll: z.object({ hero: Hero, caster: z.enum(['mage', 'priest']).nullable().optional(), level: z.number().int().min(0).max(12).nullable().optional() }),
  give_xp: z.object({ hero: Hero, amount: z.number().int().min(1).max(5000), reason: z.string().max(200).optional() }),
  add_companion: z.object({ monster_id: z.string(), battles: z.number().int().min(1).max(20) }),
  rest: z.object({ days: z.number().int().min(1).max(30) }),
  final_duel_attack: z.object({ hero: Hero }),
  drink_fountain: z.object({}),
}
export type GmToolName = keyof typeof SCHEMAS

export interface ToolOutcome {
  content: string
  isError?: boolean
  /** инструмент начал бой — ведущему пора закончить реплику */
  endsTurn?: boolean
}

/** Основа русского слова без окончания: «гномы» → «гном», «рыцари» → «рыцар», «смерти» → «смерт» */
function stemRu(w: string): string {
  const x = w.toLowerCase().replace(/ё/g, 'е')
  const m = x.match(/^(.{3,}?)(ами|ями|ого|его|ому|ему|ыми|ими|ой|ей|ий|ый|ая|яя|ое|ее|ые|ие|ов|ев|ам|ям|ах|ях|ом|ем|а|я|у|ю|е|ы|и|о|ь)$/)
  return m ? m[1] : x
}
const stems = (s: string) => s.split(/[\s-]+/).filter(Boolean).map(stemRu)

const WHEN = { win: 'после победы в бою', lose: 'после поражения в бою', flee: 'если герои бежали из боя', ok: 'если проверка удачи прошла', fail: 'если проверка удачи не прошла' } as const
const has = (h?: ParagraphHints) => !!h && Object.values(h).some((v) => (Array.isArray(v) ? v.length : !!v))

/** Этап параграфа для модели: когда открывается, что видно, что тайно, механика и следующие этапы. Подсказки — свои у
 *  каждого этапа: награда за победу не должна выглядеть лежащей на виду */
function stagePayload(n: BookNode): Record<string, unknown> {
  const on = n.on
  const when = on === 'enter' ? undefined : on === 'choice' ? `по выбору игроков: «${n.label ?? ''}»` : typeof on === 'object'
    ? ('roll' in on ? `если на кубике выпало ${on.roll.join(', ')}` : `когда случилось: «${n.label ?? ''}» (в этом или другом помещении)`) : WHEN[on]
  const visible = n.text.filter((x) => !x.gm).map((x) => x.t).join(' ')
  const secret = n.text.filter((x) => x.gm).map((x) => x.t)
  // условие исхода из книги («Если вы выходите из схватки победителем») — часть текста этапа
  const lead = n.label && on !== 'choice' && on !== 'enter' && !(typeof on === 'object' && 'roll' in on) ? `${n.label} — ` : ''
  const npcs = [...(n.hints?.monsters ?? []).filter((m) => idx.monsterById.get(m)?.special).map((m) => idx.monster(m).name), ...(n.npcs ?? []).map((x) => idx.monsterById.get(x)?.name ?? x)]
  const kids = n.then ?? []
  // особые (Мерлин, торговец, Рот…) — в «не_враги», а не среди монстров подсказок: с ними не дерутся
  const fightable = (n.hints?.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special)
  const hints = n.hints && fightable.length !== (n.hints.monsters ?? []).length ? { ...n.hints, monsters: fightable } : n.hints
  return {
    ...(when ? { когда: when } : {}),
    текст: `${lead}${visible}`,
    ...(secret.length ? { тайное: secret } : {}),
    ...(n.teaser ? { намёк: n.teaser } : {}),
    ...(has(hints) ? { подсказки: hints } : {}),
    ...(n.hints?.attack && fightable.length ? { нападают: 'монстры этапа нападают сами — start_combat в этом же ходе' } : {}),
    ...(npcs.length ? { не_враги: npcs } : {}),
    ...(n.passWith ? { проверку_заменяет: idx.itemById.get(n.passWith)?.name ?? n.passWith } : {}),
    ...(n.dice ? { бросок: `к${n.dice.sides}${n.dice.repeat ? ', бросают для каждого' : ''}` } : {}),
    ...(n.effects?.length ? { последствия: n.effects } : {}),
    ...(n.exclusive ? { только_один_вариант: true } : {}),
    ...(n.action === 'final-duel' ? { особое: 'финальная дуэль — инструмент final_duel_attack' } : n.action === 'fountain' ? { особое: 'фонтан — инструмент drink_fountain' } : {}),
    ...(kids.length ? { дальше: kids.map(stagePayload) } : {}),
  }
}

/** Параграф для ведущего (дерево этапов, src/game/tree.ts) — без побочных эффектов: отметку «пройден» ставит тот, кто
 *  его действительно разыгрывает (инструмент open_paragraph или сервер после удачного хода) */
export function paragraphPayload(room: Room, locationId: string, n: number): string {
  const loc = idx.locationById.get(locationId)
  if (!loc) throw new GameError(`Нет локации ${locationId}`)
  const p = loc.paragraphs.find((x) => x.n === n)
  if (!p) throw new GameError(`В локации «${loc.name}» нет параграфа ${n}`)
  const before = (room.state.visited[loc.id] ?? []).includes(p.n)
  return JSON.stringify({ локация: loc.name, параграф: p.n, уже_пройден: before, этапы: stagePayload(paragraphTree(p)), напоминание: 'Этап без «когда» герои видят сразу. Остальные раскрывай, только когда наступило их условие: выбор игроков, итог боя, проверки удачи или броска. «тайное» — пометки ведущего, игрокам их не пересказывай.' })
}

/** Монстр по id или имени, в том числе в падеже и числе из текста («гномы», «рыцарей смерти»).
 *  Бесплатные модели получают ужатый промпт без списка id. Совпадение — по основам всех слов имени
 *  (а не по началу строки: иначе «гномы» становились гноллом, «драконы» — драконидом). */
export function findMonster(ref: string) {
  const byId = idx.monsterById.get(ref.trim())
  if (byId) return byId
  const norm = (x: string) => x.toLowerCase().replace(/ё/g, 'е').trim()
  const all = [...idx.monsterById.values()]
  const exact = all.find((m) => norm(m.name) === norm(ref))
  if (exact) return exact
  const want = stems(ref)
  const hits = all.filter((m) => {
    const name = stems(m.name)
    return name.length === want.length && name.every((s, i) => s === want[i])
  })
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new GameError(`Неоднозначно «${ref}»: ${hits.map((m) => `${m.id} (${m.name})`).join(', ')}`)
  // одно слово запроса — среди многословных имён («драконы» → белый, красный… дракон): пусть модель уточнит
  const partial = want.length === 1 ? all.filter((m) => stems(m.name).includes(want[0])) : []
  if (partial.length) throw new GameError(`Уточните монстра «${ref}»: ${partial.map((m) => `${m.id} (${m.name})`).join(', ')}`)
  return undefined
}

function findHero(room: Room, ref: string): Hero {
  const s = ref.trim().toLowerCase()
  const h = room.state.heroes.find((x) => x.uid === ref) ?? room.state.heroes.find((x) => x.name.toLowerCase() === s)
  if (!h) throw new GameError(`Нет героя «${ref}». Герои: ${room.state.heroes.map((x) => `${x.name} [${x.uid}]`).join(', ')}`)
  return h
}

/** инструменты, меняющие игру (в отличие от чтения параграфа и бросков) */
const MUTATING = new Set(['start_combat', 'change_lives', 'change_money', 'give_item', 'give_artifact', 'give_scroll', 'give_xp', 'add_companion', 'rest', 'final_duel_attack', 'drink_fountain'])

/** сколько изменений игры модель может сделать за ход: «каждый теряет жизнь и получает 25 монет» — по два на героя */
export const changeBudget = (room: Room) => Math.max(8, 3 * room.state.heroes.length)

export function executeGmTool(room: Room, name: string, input: unknown): ToolOutcome {
  // реплика игрока («убей Боба», «дай всем по 5000») не превратится в десятки вызовов; неудачные вызовы
  // (опечатка в имени, не хватает монет) бюджет не тратят
  const mutating = MUTATING.has(name)
  if (mutating && (room.gmChanges ?? 0) >= changeBudget(room)) return { content: 'Слишком много изменений за один ход — остальное отложи до следующего хода.', isError: true }
  const out = runGmTool(room, name, input)
  if (mutating && !out.isError) room.gmChanges = (room.gmChanges ?? 0) + 1
  return out
}

function runGmTool(room: Room, name: string, input: unknown): ToolOutcome {
  const schema = (SCHEMAS as Record<string, z.ZodTypeAny>)[name]
  if (!schema) return { content: `Неизвестный инструмент ${name}`, isError: true }
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }), isError: true }
  const a = parsed.data as Record<string, unknown>
  const s = room.session()
  const json = (v: unknown) => JSON.stringify(v)
  try {
    switch (name as GmToolName) {
      case 'open_paragraph': {
        const content = paragraphPayload(room, String(a.location_id), Number(a.n))
        room.gmOpened.push({ loc: String(a.location_id), n: Number(a.n) })
        return { content }
      }
      case 'roll_luck': {
        const h = findHero(room, String(a.hero))
        return { content: json({ герой: h.name, ...s.luckCheck(h.uid, Number(a.target)) }) }
      }
      case 'roll_dice':
        return { content: json(s.rollDice(String(a.formula))) }
      case 'start_combat': {
        const specs = (a.monsters as { id: string; count: number }[]).map((m) => {
          const mon = findMonster(m.id)
          if (!mon) throw new GameError(`Нет монстра «${m.id}» в Бестиарии`)
          if (mon.special) throw new GameError(`${mon.name} — персонаж без боевых характеристик, бой с ним невозможен`)
          return { monsterId: mon.id, count: m.count }
        })
        s.startEncounter(specs)
        return { content: json({ бой: 'начат', противники: room.state.combat?.monsters.map((m) => m.name), указание: 'Игроки сражаются в интерфейсе боя. Опиши начало схватки одной-двумя фразами и закончи реплику.' }), endsTurn: true }
      }
      case 'change_lives': {
        const h = findHero(room, String(a.hero))
        s.adjustLives(h.uid, Number(a.delta))
        return { content: json({ герой: h.name, жизни: `${h.lives}/${h.maxLives}`, без_сознания: !!h.status.unconscious, мёртв: !!h.status.dead }) }
      }
      case 'change_money': {
        const h = findHero(room, String(a.hero))
        s.adjustMoney(h.uid, Number(a.delta))
        return { content: json({ герой: h.name, монеты: h.money }) }
      }
      case 'give_item': {
        const h = findHero(room, String(a.hero))
        const kind = String(a.kind)
        const ref = String(a.ref)
        if (kind === 'bottle') {
          if (!/^[1-6]$/.test(ref)) throw new GameError('Бутылка: ref от "1" до "6"')
          s.giveItem(h.uid, 'bottle', ref, Number(a.qty), false)
        } else {
          const ok = kind === 'weapon' ? idx.weaponById.has(ref) : kind === 'armor' ? idx.armorById.has(ref) : idx.itemById.has(ref)
          if (!ok) throw new GameError(`Нет предмета ${kind}/${ref}. Примеры id: оружие ${[...idx.weaponById.keys()].slice(0, 8).join(', ')}…; доспехи ${[...idx.armorById.keys()].join(', ')}; вещи ${[...idx.itemById.keys()].join(', ')}`)
          s.giveItem(h.uid, kind as 'weapon' | 'armor' | 'item', ref, Number(a.qty))
        }
        return { content: json({ герой: h.name, получил: `${kind}/${ref} ×${a.qty}` }) }
      }
      case 'give_artifact': {
        const h = findHero(room, String(a.hero))
        const n = s.findArtifact(h.uid)
        return { content: json({ герой: h.name, артефакт: n ? idx.artifact(n).name : null }) }
      }
      case 'give_scroll': {
        const h = findHero(room, String(a.hero))
        s.giveScroll(h.uid, (a.caster as 'mage' | 'priest' | null) ?? undefined, (a.level as number | null) ?? undefined)
        const last = h.inventory.filter((e) => e.kind === 'scroll').at(-1)
        return { content: json({ герой: h.name, свиток: last ? idx.spell(last.ref).name : null }) }
      }
      case 'give_xp': {
        const h = findHero(room, String(a.hero))
        s.giveXp(h.uid, Number(a.amount))
        return { content: json({ герой: h.name, опыт: h.xp, уровень: h.level }) }
      }
      case 'add_companion': {
        const mon = findMonster(String(a.monster_id))
        if (!mon || mon.special) throw new GameError(`Нет подходящего существа ${a.monster_id}`)
        s.addCompanion(mon.id, Number(a.battles))
        return { content: json({ спутник: mon.name, боёв: a.battles }) }
      }
      case 'rest':
        s.restAll(Number(a.days))
        return { content: json({ день: room.state.day, герои: room.state.heroes.map((h) => `${h.name} ${h.lives}/${h.maxLives}`) }) }
      case 'final_duel_attack': {
        const h = findHero(room, String(a.hero))
        const won = s.finalDuelAttack(h.uid)
        return { content: json({ герой: h.name, попадание: won, победа: won, жизни: `${h.lives}/${h.maxLives}` }) }
      }
      case 'drink_fountain':
        s.drinkFountain()
        return { content: json({ готово: true }) }
    }
  } catch (e) {
    return { content: (e as Error).message, isError: true }
  }
  return { content: 'Неизвестный инструмент', isError: true }
}

/** Инструменты для OpenAI-совместимых API: упрощённые схемы (без union-типов, strict и additionalProperties) */
export interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

function loosen(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(loosen)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  const src = schema as Record<string, unknown>
  const nullable = new Set<string>()
  for (const [k, v] of Object.entries(src)) {
    if (k === 'additionalProperties' || k === 'strict' || k === 'eager_input_streaming') continue
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        const p = { ...(pv as Record<string, unknown>) }
        if (Array.isArray(p.type)) { p.type = (p.type as string[]).find((t) => t !== 'null') ?? 'string'; nullable.add(pk) }
        if (Array.isArray(p.enum)) p.enum = (p.enum as unknown[]).filter((e) => e !== null)
        props[pk] = loosen(p)
      }
      out.properties = props
      continue
    }
    out[k] = loosen(v)
  }
  if (Array.isArray(out.required)) {
    // необязательными становятся поля, допускавшие null, и пояснения reason
    out.required = (out.required as string[]).filter((r) => !nullable.has(r) && r !== 'reason' && r !== 'qty')
  }
  return out
}

export const GM_TOOLS_OPENAI: OpenAiTool[] = GM_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description ?? '', parameters: loosen(t.input_schema) as Record<string, unknown> },
}))
