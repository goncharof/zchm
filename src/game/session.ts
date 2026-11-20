/**
 * Игровая сессия: все команды партии над сериализуемым GameState.
 * Один и тот же код выполняется в браузере (одиночная игра) и на сервере (сетевая игра).
 * Не зависит от Vue и от localStorage.
 */
import type { BookEffect, Caster, WorldMap } from '@/types'
import { gameData, idx } from '@/data'
import type { CombatState, EquipSlot, GameState, Hero, InventoryKind, LogEntry } from '@/engine/model'
import { SAVE_VERSION, uid } from '@/engine/model'
import { artifactSlot, changeLives, consumePrayer, createHero, gainXp, hasWard, heroLuck, isActive, isConscious, rest, type LevelUp } from '@/engine/character'
import * as inv from '@/engine/inventory'
import { k18, roll, rollFormula } from '@/engine/dice'
import { castSpell, type CastResult } from '@/engine/spells'
import { makeAlly, cleanupAfterCombat, grantRoundActions, heroRoll, endHeroesTurn as endHeroesTurnEngine, closeToMelee, finishCombat, heroAttack, heroFlee, heroSkip, markActed, monstersTurn, startCombat, type EncounterSpec } from '@/engine/combat'
import { rollRoadEncounters, shortestRoute } from '@/engine/world'
import { TROPHIES, takeLootItem } from '@/engine/loot'
import { plural } from '@/ui/format'
import { effectLabel, findNode, gameHasOutcomes, gameLimit, gamesPlayed, paragraphTree } from './tree'
import { DEAD_AT, REST_COST_PER_DAY, REST_LIVES_PER_DAY, REST_MANA_PER_DAY, XP_ARTIFACT_FOUND, XP_TRAP_FOUND } from '@/engine/rules'

export const LOG_CAP = 500
/** Больше всего противников в одном бою (и одного вида) */
export const MAX_FOES = 60
const LOG_KINDS: NonNullable<LogEntry['kind']>[] = ['hit', 'miss', 'damage', 'spell', 'info', 'xp', 'death', 'flee', 'luck']

/** Ожидаемая ошибка игры (нет дороги, не хватает монет…): показывается игроку как уведомление */
export class GameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GameError'
  }
}

export function blankGame(startNodeId = 'zolotoy-gorod'): GameState {
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heroes: [],
    worldNodeId: startNodeId,
    seenNodes: startNodeId ? [startNodeId] : [],
    locationId: null,
    visited: {},
    day: 1,
    gmMode: false,
    combat: null,
    log: [],
    artifactsFound: [],
    pendingRoad: [],
    startNodeId,
    companions: [],
  }
}

/** Дозаполняет поля, появившиеся в более новых версиях состояния */
export function migrate(g: GameState): GameState {
  g.pendingRoad ??= []
  // таверна Северного форта в оцифрованном издании напечатана как § 38, на плане это § 37: старые отметки переносятся
  const fort = g.visited?.['severnyy-fort']
  if (fort?.includes(38)) g.visited['severnyy-fort'] = [...new Set(fort.map((n) => (n === 38 ? 37 : n)))]
  if (g.claimed?.some((k) => k.startsWith('severnyy-fort:38:'))) g.claimed = g.claimed.map((k) => k.replace(/^severnyy-fort:38:/, 'severnyy-fort:37:'))
  g.artifactsFound ??= []
  g.startNodeId ??= g.worldNodeId ?? 'zolotoy-gorod'
  // карта мира открывается постепенно: в старом сохранении известны старт и место, где партия стоит
  g.seenNodes ??= [...new Set([g.startNodeId, g.worldNodeId].filter((x): x is string => !!x))]
  g.companions ??= []
  if (g.combat) {
    g.combat.allies ??= []
    g.combat.extraActions ??= {}
    g.combat.escaped ??= []
    g.combat.recover ??= {}
  }
  for (const h of g.heroes) {
    h.buffs ??= []
    h.status ??= {}
    h.pendingSpellPicks ??= 0
    // лук и арбалет больше не смазывают ядом (смазывают стрелы): флаг из старых сохранений снимается
    for (const e of h.inventory) {
      if (!e.poisoned) continue
      const bow = e.kind === 'weapon' ? ['bow', 'crossbow'].includes(idx.weaponById.get(e.ref)?.group ?? '') : e.kind === 'artifact' && idx.artifactByN.get(parseInt(e.ref, 10))?.kind === 'ranged'
      if (bow) delete e.poisoned
    }
    // прежние слоты «украшение 1/2» → свой слот у каждого украшения-артефакта
    const eq = h.equipment as Record<string, string | undefined>
    for (const old of ['accessory1', 'accessory2']) {
      const uid = eq[old]
      if (!uid) continue
      delete eq[old]
      const e = h.inventory.find((x) => x.uid === uid)
      if (e?.kind === 'artifact') eq[artifactSlot(parseInt(e.ref, 10))] = uid
    }
  }
  return g
}

export function parseSave(text: string): GameState {
  const g = JSON.parse(text) as GameState
  if (!g || g.version !== SAVE_VERSION || !Array.isArray(g.heroes)) throw new GameError('Это не сохранение игры')
  return migrate(g)
}

/** Быстрый старт: четыре героя со снаряжением на стартовые 40 монет */
const QUICK_PARTY: { name: string; classId: string; kit: { kind: 'weapon' | 'armor'; ref: string; qty?: number; slot?: EquipSlot }[] }[] = [
  { name: 'Конан', classId: 'warrior', kit: [{ kind: 'weapon', ref: 'mech-korotkiy' }, { kind: 'armor', ref: 'kozhanyy-dospeh' }, { kind: 'armor', ref: 'schit' }] },
  { name: 'Мерлин', classId: 'mage', kit: [{ kind: 'weapon', ref: 'kinzhal' }, { kind: 'weapon', ref: 'drotik', qty: 10 }] },
  { name: 'Брат Тук', classId: 'priest', kit: [{ kind: 'weapon', ref: 'palitsa' }] },
  { name: 'Бильбо', classId: 'thief', kit: [{ kind: 'weapon', ref: 'mech-korotkiy' }, { kind: 'weapon', ref: 'arbalet' }, { kind: 'weapon', ref: 'strela', qty: 10 }] },
]

export class GameSession {
  constructor(public state: GameState, public world: WorldMap | null) {}

  // ---------- служебное ----------
  get heroes(): Hero[] { return this.state.heroes }
  get combat(): CombatState | null { return this.state.combat }

  log(text: string, kind: LogEntry['kind'] = 'info'): void {
    // запись журнала — только известного вида и в разумных пределах: описания артефактов и заклинаний цитируются
    // целиком (до 800 знаков), а текст игроков (заметки) обрезает note()
    const k = LOG_KINDS.includes(kind as NonNullable<LogEntry['kind']>) ? kind : 'info'
    this.state.log.push({ t: Date.now(), text: String(text).slice(0, 4000), kind: k })
    if (this.state.log.length > LOG_CAP) this.state.log.splice(0, this.state.log.length - LOG_CAP)
  }
  logAll(entries: LogEntry[]): void {
    for (const e of entries) this.log(e.text, e.kind)
  }
  /** Запись в журнал от игрока или интерфейса (результат броска по списку и т.п.) */
  note(text: string, kind: LogEntry['kind'] = 'info'): void {
    this.log(String(text).slice(0, 500), kind)
  }
  hero(heroUid: string): Hero {
    const h = this.heroes.find((x) => x.uid === heroUid)
    if (!h) throw new GameError('Герой не найден')
    return h
  }
  announceLevelUps(ups: LevelUp[]): void {
    for (const up of ups) {
      const h = this.hero(up.heroUid)
      const parts = [`жизни ${h.maxLives}`]
      if (h.maxMana) parts.push(`мана ${h.maxMana}`)
      if (up.bonus) parts.push(Object.entries(up.bonus).map(([k, v]) => `${({ strength: 'сила', dexterity: 'ловкость', accuracy: 'меткость', luck: 'удача', defense: 'защита' } as Record<string, string>)[k]} +${v}`).join(', '))
      if (up.special) parts.push(up.special)
      if (up.spellPick) parts.push('можно выбрать новое заклинание')
      this.log(`${h.name} достигает ${up.level} уровня: ${parts.join('; ')}.`, 'xp')
    }
  }

  // ---------- партия ----------
  /** Начать заново в этом же объекте состояния (сохраняет ссылку для сервера и реактивности) */
  newGame(startNodeId?: string): void {
    const fresh = blankGame(startNodeId)
    for (const k of Object.keys(this.state) as (keyof GameState)[]) delete (this.state as Partial<GameState>)[k]
    Object.assign(this.state, fresh)
    this.log('Новая партия. Каждый герой получает 40 монет на снаряжение.')
  }
  addHero(name: string, classId: string): Hero {
    const cls = idx.data.classes.find((c) => c.id === classId)
    if (!cls) throw new GameError('Нет такого класса')
    // в правилах числа героев нет; шесть — предел интерфейса, проверяется здесь, чтобы его не обходили по сети
    if (this.heroes.length >= 6) throw new GameError('Не больше шести героев в партии')
    // ХАУСРУЛ владельца: в одной команде классы не повторяются (погибшего можно заменить героем того же класса)
    if (!this.state.allowDuplicateClasses && this.heroes.some((h) => !h.status.dead && h.classId === classId)) {
      throw new GameError(`В команде уже есть ${cls.name.toLowerCase()}: в одной команде классы не повторяются`)
    }
    const h = createHero(String(name).slice(0, 40), classId, idx)
    this.heroes.push(h)
    this.log(`В команду вступает ${h.name} (${idx.cls(classId).name}).`)
    return h
  }
  /** Разрешить или запретить героев одного класса в команде */
  setAllowDuplicateClasses(on: boolean): void {
    this.state.allowDuplicateClasses = !!on
    this.log(on ? 'Теперь в команде можно иметь героев одного класса.' : 'В команде снова только разные классы.')
  }
  quickStart(): void {
    this.newGame()
    for (const p of QUICK_PARTY) {
      const h = this.addHero(p.name, p.classId)
      for (const k of p.kit) {
        const e = inv.buy(h, k.kind, k.ref, idx, k.qty ?? 1)
        const w = k.kind === 'weapon' ? idx.weapon(k.ref) : null
        if (!w || w.group !== 'ammo') inv.equip(h, e.uid, idx, k.slot)
      }
    }
    this.log('Быстрый старт: партия собрана и снаряжена. Отправляйтесь в путь с карты мира.')
  }
  removeHero(heroUid: string): void {
    this.state.heroes = this.heroes.filter((h) => h.uid !== heroUid)
  }
  renameHero(heroUid: string, name: string): void {
    const h = this.hero(heroUid)
    h.name = String(name).trim().slice(0, 40) || h.name
  }
  setStart(nodeId: string): void {
    if (this.state.day !== 1 || Object.keys(this.state.visited).length) throw new GameError('Стартовую точку выбирают до начала пути')
    // команда приходит и по сети: начать можно в городе или крепости карты, но не в замке Чёрного мага
    const node = this.world?.nodes.find((n) => n.id === nodeId)
    if (this.world && (!node?.locationId || node.locationId === 'zamok-chernogo-maga')) throw new GameError('Начать можно в городе или крепости, но не в замке Чёрного мага')
    this.state.worldNodeId = nodeId
    this.state.startNodeId = nodeId
    this.state.seenNodes = [nodeId]
  }
  toggleGm(): void {
    this.state.gmMode = !this.state.gmMode
  }

  // ---------- лавка и вещи ----------
  /** Количество из команды: целое от 1 (команды приходят и по сети — отрицательное число не должно давать денег) */
  private qty(n: unknown, max = 999): number {
    const v = Number(n)
    if (!Number.isInteger(v) || v < 1 || v > max) throw new GameError('Неверное количество')
    return v
  }
  /** Целое из команды (команды приходят и по сети: строка вместо числа делала жизни, монеты и опыт NaN) */
  private int(n: unknown, max = 100000): number {
    const v = Math.trunc(Number(n))
    if (!Number.isFinite(v) || Math.abs(v) > max) throw new GameError('Нужно целое число')
    return v
  }
  buyItem(heroUid: string, kind: 'weapon' | 'armor' | 'item', ref: string, qty = 1): void {
    const h = this.hero(heroUid)
    qty = this.qty(qty, 99)
    let e
    try { e = inv.buy(h, kind, String(ref), idx, qty) } catch (err) { throw new GameError((err as Error).message) }
    this.log(`${h.name} покупает: ${inv.entryName(e, idx)}${qty > 1 ? ` ×${qty}` : ''}.`)
  }
  sellItem(heroUid: string, entryUid: string, qty = 1): void {
    const h = this.hero(heroUid)
    const e = h.inventory.find((x) => x.uid === entryUid)
    if (!e) throw new GameError('Предмета нет в инвентаре')
    if (e.kind === 'artifact') throw new GameError('Артефакты не продаются')
    const name = inv.entryName(e, idx)
    const gain = inv.sell(h, entryUid, idx, this.qty(qty, e.qty))
    this.log(`${h.name} продаёт ${name} за ${gain} монет.`)
  }
  equipItem(heroUid: string, entryUid: string, slot?: EquipSlot): void {
    inv.equip(this.hero(heroUid), entryUid, idx, slot)
  }
  unequipItem(heroUid: string, slot: EquipSlot): void {
    inv.unequip(this.hero(heroUid), slot)
  }
  giveItem(heroUid: string, kind: InventoryKind, ref: string, qty = 1, identified?: boolean): void {
    const h = this.hero(heroUid)
    // команда приходит и по сети: несуществующая вещь в инвентаре ломает экраны и броски (бутылка (9), чужой id)
    ref = String(ref)
    const known = kind === 'weapon' ? idx.weaponById.has(ref) : kind === 'armor' ? idx.armorById.has(ref) : kind === 'item' ? idx.itemById.has(ref)
      : kind === 'bottle' ? /^[1-6]$/.test(ref) : kind === 'scroll' ? idx.spellById.has(ref) : kind === 'trophy' ? Object.hasOwn(TROPHIES, ref)
      : kind === 'artifact' ? idx.artifactByN.has(Number(ref)) : false
    if (!known) throw new GameError(`Нет такой вещи: ${kind}/${ref}`)
    qty = this.qty(qty)
    const e = inv.addToInventory(h, kind, ref, qty, identified === undefined ? {} : { identified: !!identified })
    this.log(`${h.name} получает: ${inv.entryName(e, idx)}${qty > 1 ? ` ×${qty}` : ''}.`)
  }
  dropItem(heroUid: string, entryUid: string, qty = 1): void {
    const h = this.hero(heroUid)
    const e = h.inventory.find((x) => x.uid === entryUid)
    if (!e) return
    // Инструкция: артефакты «вы не можете их потерять»
    if (e.kind === 'artifact') throw new GameError('Артефакт нельзя выбросить')
    inv.removeFromInventory(h, entryUid, this.qty(qty, e.qty))
  }
  transferItem(fromUid: string, toUid: string, entryUid: string): void {
    const from = this.hero(fromUid)
    const to = this.hero(toUid)
    const e = from.inventory.find((x) => x.uid === entryUid)
    if (!e || from.uid === to.uid) return
    // запомнить вещь до снятия: removeFromInventory уменьшает qty у того же объекта
    const { kind, ref, qty, identified, poisoned, verdict } = e
    inv.removeFromInventory(from, entryUid, qty)
    const moved = inv.addToInventory(to, kind, ref, qty, { ...(identified !== undefined ? { identified } : {}), ...(poisoned ? { poisoned } : {}), ...(verdict ? { verdict } : {}) })
    this.log(`${from.name} передаёт ${inv.entryName(moved, idx)}${qty > 1 ? ` ×${qty}` : ''} — ${to.name}.`)
  }
  drink(heroUid: string, entryUid: string): void {
    const h = this.hero(heroUid)
    if (!isConscious(h)) throw new GameError(`${h.name} не может пить: ${h.status.dead ? 'погиб' : 'без сознания'}`)
    const r = inv.drinkBottle(h, entryUid, idx)
    this.log(`${h.name} пьёт из бутылки (${r.n}). ${r.text}`, r.died ? 'death' : 'info')
  }
  /** Распознаватель напитков (стр. 21): говорит только «опасен или нет», что именно в бутылке — не знает; ошибается
   *  с вероятностью 1/6. Ответ записывается на бутылку, и проверить её второй раз нельзя (иначе ошибку обходили бы повтором) */
  identifyBottle(heroUid: string, entryUid: string): void {
    const h = this.hero(heroUid)
    const e = h.inventory.find((x) => x.uid === entryUid)
    if (!e || e.kind !== 'bottle') return
    if (e.identified) throw new GameError('Эта бутылка уже опознана')
    if (e.verdict) throw new GameError(`Эту бутылку уже проверяли: ${e.verdict === 'safe' ? 'безопасна' : 'опасна'}`)
    const has = this.heroes.some((x) => x.inventory.some((i) => i.kind === 'item' && i.ref === 'raspoznavatel-napitkov'))
    if (!has) throw new GameError('Нужен распознаватель напитков')
    const good = parseInt(e.ref, 10) >= 4
    const wrong = roll(6) === 1
    e.verdict = good !== wrong ? 'safe' : 'danger'
    this.log(`${h.name} проверяет бутылку распознавателем: ${e.verdict === 'safe' ? 'напиток безопасен' : 'опасно — не пейте'}.`)
  }
  copyScroll(heroUid: string, entryUid: string): void {
    const h = this.hero(heroUid)
    this.log(`${h.name}: ${inv.copyScroll(h, entryUid, idx)}`, 'spell')
  }
  learnSpell(heroUid: string, spellId: string): void {
    const h = this.hero(heroUid)
    const s = idx.spell(spellId)
    if (h.pendingSpellPicks <= 0) throw new GameError('Нет доступных выборов заклинаний')
    if (s.caster !== idx.cls(h.classId).caster) throw new GameError('Заклинание другого класса')
    if (s.level > h.level) throw new GameError('Уровень заклинания выше уровня персонажа')
    if (h.spellbook.includes(spellId)) throw new GameError('Уже в книге')
    h.spellbook.push(spellId)
    h.pendingSpellPicks -= 1
    this.log(`${h.name} записывает в книгу заклинание «${s.name}».`, 'spell')
  }
  useAntidote(ownerUid: string, targetUid: string): void {
    inv.useAntidote(this.hero(targetUid), this.hero(ownerUid), idx)
    this.log(`${this.hero(targetUid).name} принимает противоядие.`)
  }
  useParalysisPotion(ownerUid: string, targetUid: string): void {
    inv.useParalysisPotion(this.hero(targetUid), this.hero(ownerUid), idx)
    this.log(`${this.hero(ownerUid).name} даёт зелье от паралича — ${this.hero(targetUid).name} снова может двигаться.`)
  }
  poisonWeapon(heroUid: string, weaponUid: string): void {
    inv.poisonWeapon(this.hero(heroUid), weaponUid, idx)
    this.log(`${this.hero(heroUid).name} смазывает оружие ядом.`)
  }
  adjustLives(heroUid: string, delta: number): void {
    const h = this.hero(heroUid)
    delta = this.int(delta, 1000)
    const before = h.lives
    changeLives(h, delta)
    this.log(`${h.name}: жизни ${before} → ${h.lives}.`, delta < 0 ? 'damage' : 'info')
  }
  adjustMana(heroUid: string, delta: number): void {
    const h = this.hero(heroUid)
    delta = this.int(delta, 1000)
    h.mana = Math.max(0, Math.min(h.maxMana, h.mana + delta))
  }
  adjustMoney(heroUid: string, delta: number): void {
    const h = this.hero(heroUid)
    delta = this.int(delta)
    if (delta < 0 && h.money + delta < 0) throw new GameError(`У ${h.name} не хватает монет`)
    h.money = Math.max(0, h.money + delta)
    this.log(`${h.name}: ${delta >= 0 ? '+' : ''}${delta} монет (всего ${h.money}).`)
  }
  giveXp(heroUid: string, amount: number): void {
    const h = this.hero(heroUid)
    amount = Math.max(0, this.int(amount))
    this.announceLevelUps(gainXp(h, amount, idx))
    this.log(`${h.name} получает ${amount} очков опыта.`, 'xp')
  }

  // ---------- трактир ----------
  /** Путь, отдых и переход в другую локацию — не посреди боя (команды приходят и по сети) */
  private noFight(): void {
    if (this.combat && !this.combat.finished) throw new GameError('Сначала закончите бой')
  }
  restAll(days: number): void {
    this.noFight()
    const d = Math.floor(Number(days))
    days = Number.isFinite(d) ? Math.max(1, Math.min(30, d)) : 1
    for (const h of this.heroes) {
      if (h.status.dead) continue
      const r = rest(h, days, REST_COST_PER_DAY, REST_LIVES_PER_DAY, REST_MANA_PER_DAY)
      if (r.days < days) this.log(`${h.name} может оплатить только ${r.days} сут. из ${days}.`)
    }
    for (const c of this.state.companions) c.lives = Math.min(c.maxLives, c.lives + REST_LIVES_PER_DAY * days)
    this.state.day += days
    this.log(`Команда отдыхает в трактире: ${days} ${plural(days, 'сутки', 'суток', 'суток')} (2 монеты в сутки с каждого; +5 жизней и +5 маны в сутки). День ${this.state.day}.`)
  }

  // ---------- мир и локации ----------
  travelTo(nodeId: string): void {
    if (!this.world || !this.state.worldNodeId) throw new GameError('Карта мира не загружена')
    this.noFight()
    const route = shortestRoute(this.world, this.state.worldNodeId, nodeId)
    if (!route) throw new GameError('Туда нет дороги')
    // верхом — если конь есть у каждого живого (погибших везут)
    const living = this.heroes.filter((h) => !h.status.dead)
    const allMounted = living.length > 0 && living.every((h) => h.inventory.some((e) => e.kind === 'item' && e.ref === 'kon'))
    // призрачный дракон несёт всю партию: три клетки за день (стр. 39), на один переход
    const flying = !!this.state.flight
    const days = flying ? Math.ceil(route.days / 3) : allMounted ? Math.ceil(route.days / 2) : route.days
    delete this.state.flight
    const road = idx.locationById.get('doroga')
    const encounters = rollRoadEncounters(days, road ? road.paragraphs.map((p) => p.n) : [])
    this.state.day += days
    this.state.worldNodeId = nodeId
    // карта открывается постепенно: партия запоминает все узлы, через которые прошла
    this.state.seenNodes = [...new Set([...(this.state.seenNodes ?? []), ...route.nodes])]
    this.state.locationId = null
    this.state.pendingRoad.push(...encounters)
    // встреча в пути может повториться в другом походе — прежние отметки взятого на ней не действуют
    if (encounters.length && this.state.claimed) this.state.claimed = this.state.claimed.filter((k) => !encounters.some((n) => k.startsWith(`doroga:${n}:`)))
    const target = this.world.nodes.find((n) => n.id === nodeId)
    const legs = route.nodes.length - 1
    this.log(`Переход: ${legs} ${plural(legs, 'участок', 'участка', 'участков')} дороги, ${days} ${plural(days, 'день', 'дня', 'дней')} пути${flying ? ' на призрачном драконе' : allMounted ? ' верхом' : ''}. Прибытие — ${target?.name ?? nodeId}, день ${this.state.day}.${encounters.length ? ` В пути ${plural(encounters.length, 'случилась', 'случились', 'случилось')} ${encounters.length} ${plural(encounters.length, 'встреча', 'встречи', 'встреч')}: «Дорога», ${encounters.map((n) => `§ ${n}`).join(', ')}.` : ''}`)
  }
  enterLocation(locationId: string): void {
    if (!idx.locationById.has(locationId)) throw new GameError('Нет такой локации')
    this.noFight()
    // войти можно туда, где стоит партия на карте (ведущий в одиночной игре — куда угодно)
    if (this.world && this.state.worldNodeId && !this.state.gmMode) {
      const node = this.world.nodes.find((n) => n.id === this.state.worldNodeId)
      if (node?.locationId !== locationId) throw new GameError('Сначала дойдите до этой локации по карте')
    }
    this.state.locationId = locationId
    this.log(`Партия входит: ${idx.locationById.get(locationId)?.name ?? locationId}.`)
  }
  leaveLocation(): void {
    this.state.locationId = null
  }
  markVisited(locationId: string, n: number): void {
    if (!idx.locationById.get(locationId)?.paragraphs.some((p) => p.n === Number(n))) throw new GameError('Нет такого помещения')
    n = Number(n)
    const arr = (this.state.visited[locationId] ??= [])
    if (!arr.includes(n)) arr.push(n)
  }
  dismissRoad(n: number): void {
    const i = this.state.pendingRoad.indexOf(n)
    if (i >= 0) this.state.pendingRoad.splice(i, 1)
  }

  // ---------- действия по параграфу ----------
  rollDie(sides: number, context?: string): number {
    const n = Math.floor(Number(sides))
    sides = Number.isFinite(n) ? Math.max(2, Math.min(100, n)) : 6
    const r = roll(sides)
    this.log(`${context ? `${String(context).slice(0, 120)}: ` : ''}к${sides} = ${r}.`, 'luck')
    return r
  }
  rollDice(formula: string): { total: number; rolls: number[] } {
    let r
    formula = String(formula).replace(/\s+/g, '').slice(0, 40)
    try { r = rollFormula(formula) } catch (e) { throw new GameError((e as Error).message) }
    this.log(`Бросок: ${formula} = ${r.total}${r.rolls.length > 1 ? ` (${r.rolls.join(' + ')})` : ''}.`, 'luck')
    return { total: r.total, rolls: r.rolls }
  }
  /** Бросок удачи героя: благословение «Удача» — успех без броска, «Молитва» +3, «Несчастье» — меньший из двух */
  private luckRoll(h: Hero): { roll: number; blessed: boolean } {
    const blessing = hasWard(h, 'luck')
    if (blessing) {
      h.buffs = h.buffs.filter((b) => b !== blessing)
      return { roll: 18, blessed: true }
    }
    return { roll: heroRoll(h) + consumePrayer(h), blessed: false }
  }
  /** place — этап книги «локация:номер:этап»: итог проверки отмечается, и открываются её исходы */
  luckCheck(heroUid: string, target: number, place?: string): { ok: boolean; roll: number; luck: number } {
    const h = this.hero(heroUid)
    target = this.int(target, 100)
    const at = place == null ? undefined : this.bookPlace(place)
    const lr = this.luckRoll(h)
    if (lr.blessed) {
      this.log(`${h.name}: боги даруют удачу — проверка ${target} пройдена без броска.`, 'luck')
      if (at) this.mark(`${at}:ok`)
      return { ok: true, roll: 18, luck: heroLuck(h, idx) }
    }
    const r = lr.roll
    const luck = heroLuck(h, idx)
    const ok = r + luck >= target
    this.log(`${h.name} бросает удачу ${target}: к18 = ${r}${luck ? ` + ${luck}` : ''} — ${ok ? 'удача!' : 'неудача'}.`, 'luck')
    if (at) this.mark(`${at}:${ok ? 'ok' : 'fail'}`)
    return { ok, roll: r, luck }
  }
  findArtifact(heroUid: string): number | null {
    const h = this.hero(heroUid)
    const free = idx.data.artifacts.map((a) => a.n).filter((x) => !this.state.artifactsFound.includes(x))
    if (!free.length) throw new GameError('Все артефакты уже найдены')
    let n = k18()
    // ХАУСРУЛ: выпал уже найденный — берётся случайный из оставшихся (перебросы до упора иногда не находили последний)
    if (this.state.artifactsFound.includes(n)) n = free[roll(free.length) - 1]
    this.state.artifactsFound.push(n)
    const a = idx.artifact(n)
    inv.addToInventory(h, 'artifact', String(n))
    this.log(`Артефакт! к18 = ${n}: ${a.name}. ${h.name} берёт его. Все получают ${XP_ARTIFACT_FOUND} очков опыта.`, 'xp')
    for (const x of this.heroes) if (isConscious(x)) this.announceLevelUps(gainXp(x, XP_ARTIFACT_FOUND, idx))
    return n
  }
  giveScroll(heroUid: string, caster?: Caster, level?: number): void {
    const h = this.hero(heroUid)
    const c: Caster = caster ?? (roll(2) === 1 ? 'mage' : 'priest')
    const pool = gameData.spells.filter((s) => s.caster === c && (level === undefined ? s.level > 0 : s.level === level))
    if (!pool.length) throw new GameError('Нет подходящего заклинания')
    const s = pool[roll(pool.length) - 1]
    inv.addToInventory(h, 'scroll', s.id, 1, { identified: true })
    this.log(`${h.name} получает свиток: «${s.name}» (${c === 'mage' ? 'маг' : 'жрец'}, ${s.level} ур.).`, 'spell')
  }
  /**
   * Финал (Замок Чёрного мага, §13): попасть в мага — удача 15; при промахе маг бросает огненный шар
   * (удача 11, иначе −1к18 жизней — ХАУСРУЛ: урон шара в книге не указан). Попадание — победа,
   * корона (1000 монет) и артефакт.
   */
  finalDuelAttack(heroUid: string): boolean {
    const h = this.hero(heroUid)
    // схватка — только в зале Чёрного мага (Замок, § 13), живым героем и пока маг не повержен
    if (this.state.victory) throw new GameError('Чёрный маг уже повержен')
    if (this.state.locationId !== 'zamok-chernogo-maga' || !(this.state.visited['zamok-chernogo-maga'] ?? []).includes(13)) throw new GameError('Чёрный маг ждёт в своём замке, в зале с фонтаном (§ 13)')
    if (h.status.dead || h.status.unconscious) throw new GameError(`${h.name} не может сражаться`)
    const r = this.luckCheck(heroUid, 15)
    if (r.ok) {
      this.log(`${h.name} поражает Чёрного мага! Маг исчезает — на его месте кучка пепла, корона и артефакт. Долина Тмамрак не войдёт в наш мир.`, 'xp')
      h.money += 1000
      this.log(`${h.name} забирает корону Чёрного мага (1000 монет).`)
      try { this.findArtifact(heroUid) } catch (e) { if (!(e instanceof GameError)) throw e }
      this.state.victory = { day: this.state.day, heroUid, heroName: h.name }
      // отметка прохождения: открывает этап «Если попадаете в Черного мага» (tools/book/zamok-chernogo-maga.json)
      this.mark('zamok-chernogo-maga:13:a:won')
      return true
    }
    // уворот от шара — обычный бросок удачи: действуют «Удача», «Молитва» и «Несчастье»
    const saveRoll = this.luckRoll(h)
    const save = saveRoll.roll
    const luck = heroLuck(h, idx)
    if (saveRoll.blessed || save + luck >= 11) {
      this.log(`Чёрный маг бросает огненный шар: ${h.name} уворачивается (${saveRoll.blessed ? 'боги даруют удачу' : `к18 = ${save}${luck ? ` + ${luck}` : ''} ≥ 11`}).`, 'luck')
    } else {
      const dmg = rollFormula('1к18').total
      const lost = -changeLives(h, -dmg)
      this.log(`Чёрный маг бросает огненный шар: ${h.name} не успевает увернуться (к18 = ${save}${luck ? ` + ${luck}` : ''} < 11) и теряет ${lost} жизней.`, 'damage')
      if (h.status.dead) this.log(`${h.name} погибает.`, 'death')
      else if (h.status.unconscious) this.log(`${h.name} теряет сознание.`, 'death')
    }
    return false
  }
  drinkFountain(): void {
    // фонтаны книги: зал Чёрного мага (Замок, § 13: «восстанавливаются все жизни и мана») и фонтан Крепости короля
    // назгулов (§ 22: «+5 жизней»)
    const at = (loc: string, n: number) => this.state.locationId === loc && (this.state.visited[loc] ?? []).includes(n)
    const castle = at('zamok-chernogo-maga', 13)
    if (!castle && !at('krepost-korolya-nazgulov', 22)) throw new GameError('Здесь нет фонтана')
    const place = castle ? 'zamok-chernogo-maga:13' : 'krepost-korolya-nazgulov:22'
    // ХАУСРУЛ: из одного фонтана — раз в день (иначе между ударами дуэли можно лечиться без конца)
    if (this.state.fountainUsed?.place === place && this.state.fountainUsed.day === this.state.day) throw new GameError('Из этого фонтана сегодня уже пили')
    this.state.fountainUsed = { place, day: this.state.day }
    for (const h of this.heroes) {
      if (h.status.dead) continue
      if (castle) {
        changeLives(h, h.maxLives - h.lives)
        h.mana = h.maxMana
        delete h.status.poison
      } else changeLives(h, 5)
    }
    this.log(castle ? 'Команда пьёт из фонтана — все жизни и мана восстановлены.' : 'Команда пьёт из фонтана: +5 жизней каждому.')
  }
  /** Отметить награду из текста книги взятой (игра без ведущего): «группа=значение», второй раз группа не берётся.
   *  Так монеты, бутылки, артефакт или бросок по списку не берутся заново после повторного открытия параграфа */
  claim(key: string): true {
    key = String(key).slice(0, 160)
    // ключ начинается с существующего места книги «локация:§» (команда приходит и по сети)
    const [loc, n] = key.split(':')
    if (!idx.locationById.get(loc)?.paragraphs.some((p) => p.n === Number(n))) throw new GameError('Нет такого места в книге')
    const group = key.split('=')[0]
    const claimed = (this.state.claimed ??= [])
    if (claimed.some((k) => k.split('=')[0] === group)) throw new GameError('Это уже взято')
    if (claimed.length >= 3000) throw new GameError('Слишком много отметок')
    claimed.push(key)
    return true
  }
  /** Этап книги «локация:номер:этап» (команда приходит и по сети): место должно существовать */
  private bookPlace(place: string): string {
    place = String(place)
    const [loc, n, ...rest] = place.split(':')
    if (place.length > 120 || !rest.length || !/^[\w.:-]+$/.test(rest.join(':')) || !idx.locationById.get(loc)?.paragraphs.some((p) => p.n === Number(n))) throw new GameError('Нет такого места в книге')
    return place
  }
  private mark(key: string): void {
    const claimed = (this.state.claimed ??= [])
    if (claimed.includes(key)) return
    if (claimed.length >= 3000) throw new GameError('Слишком много отметок')
    claimed.push(key)
  }
  /** Отметка прохождения параграфа по этапам (src/game/tree.ts): выбран вариант этапа (open) или итог задан вручную */
  bookMark(place: string, what: string): void {
    if (!['open', 'won', 'lost', 'fled', 'ok', 'fail'].includes(String(what))) throw new GameError('Неверная отметка')
    this.mark(`${this.bookPlace(place)}:${what}`)
  }
  /** Последствия этапа книги (урон, лечение, опыт, монеты, спутник) — один раз, отметка `место:fx`. Берутся из данных
   *  книги, а не из команды: по сети приходит только место. heroUid — герой, который действует */
  bookEffects(place: string, heroUid?: string): string[] {
    const at = this.bookPlace(place)
    const [loc, n, ...rest] = at.split(':')
    const p = idx.locationById.get(loc)!.paragraphs.find((x) => x.n === Number(n))!
    const node = findNode(paragraphTree(p), rest.join(':'))
    if (!node?.effects?.length) throw new GameError('У этого этапа нет последствий')
    if ((this.state.claimed ?? []).includes(`${at}:fx`)) throw new GameError('Последствия уже применены')
    const alive = this.heroes.filter((h) => !h.status.dead)
    const actor = alive.find((h) => h.uid === heroUid) ?? alive[0]
    const targets = (e: BookEffect) => ('who' in e && e.who === 'each' ? alive : actor ? [actor] : [])
    // плата за выбранный вариант («Купить артефакт за 200 монет») без нужной суммы не проходит — и отметка не ставится;
    // кража и побор («украл у вас 20 монет») забирают, сколько есть
    const paid = node.on === 'choice'
    for (const e of paid ? node.effects : []) {
      if (!('coins' in e) || typeof e.coins !== 'number' || e.coins >= 0) continue
      const poor = targets(e).find((h) => h.money < -e.coins)
      if (poor) throw new GameError(`У ${poor.name} не хватает монет`)
    }
    this.mark(`${at}:fx`)
    const out: string[] = []
    for (const e of node.effects) {
      const who = targets(e)
      if ('lives' in e) {
        for (const h of who) {
          const v = e.lives
          const delta = v === 'death' ? DEAD_AT - h.lives : v === 'half' ? -Math.ceil(Math.max(0, h.lives) / 2) : v === 'full' ? h.maxLives - h.lives : typeof v === 'object' ? ('heal' in v ? roll(v.heal) : 'set' in v ? v.set - h.lives : -roll(v.dice)) : v
          this.adjustLives(h.uid, delta)
          out.push(v === 'death' ? `${h.name} погибает.` : `${h.name}: ${delta >= 0 ? '+' : '−'}${Math.abs(delta)} ${plural(Math.abs(delta), 'жизнь', 'жизни', 'жизней')} (осталось ${h.lives}).`)
        }
      } else if ('strip' in e) {
        for (const h of who) {
          for (const x of h.inventory.filter((it) => it.kind !== 'artifact')) inv.removeFromInventory(h, x.uid, x.qty)
          out.push(`У ${h.name} не осталось вещей, кроме денег и артефактов.`)
        }
      } else if ('xp' in e) {
        for (const h of who) { this.giveXp(h.uid, e.xp); out.push(`${h.name} получает ${e.xp} опыта.`) }
      } else if ('coins' in e) {
        for (const h of who) {
          const delta = e.coins === 'half' ? -Math.floor(h.money / 2) : e.coins === 'third' ? -Math.floor(h.money / 3) : e.coins === 'all' ? -h.money : Math.max(e.coins, -h.money)
          this.adjustMoney(h.uid, delta)
          out.push(`${h.name}: ${delta >= 0 ? '+' : '−'}${Math.abs(delta)} ${plural(Math.abs(delta), 'монета', 'монеты', 'монет')} (всего ${h.money}).`)
        }
      } else {
        this.addCompanion(e.companion, e.battles ?? 3)
        out.push(`К партии присоединяется ${effectLabel(e).replace(/^спутник: /, '')}.`)
      }
    }
    return out
  }
  /** ХАУСРУЛ: игра в кости с персонажем книги — к6 героя против к6 соперника, ничья в пользу соперника. Ставка, число
   *  игр и исходы — из разметки этапа (hints.game, src/game/tree.ts), по сети приходит только место. Итог открывает
   *  исходы ok/fail этапа, а без них ставка применяется сразу: монеты или жизни */
  diceGame(heroUid: string, place: string): { won: boolean; mine: number; theirs: number; applied?: string } {
    const h = this.hero(heroUid)
    const at = this.bookPlace(place)
    const [loc, n, ...rest] = at.split(':')
    const p = idx.locationById.get(loc)!.paragraphs.find((x) => x.n === Number(n))!
    const node = findNode(paragraphTree(p), rest.join(':'))
    const g = node?.hints?.game
    if (!node || !g) throw new GameError('Здесь не играют в кости')
    if (!isConscious(h)) throw new GameError(`${h.name} сейчас не может играть`)
    const claimed = this.state.claimed ?? []
    const played = gamesPlayed(`${loc}:${n}`, node.id, claimed)
    if (played >= gameLimit(node)) throw new GameError('Соперник больше не играет')
    // ставку в монетах надо иметь и тогда, когда проигрыш записан исходом этапа (effects): без денег не играют
    if (g.stake && g.of !== 'lives' && h.money < g.stake) throw new GameError(`У ${h.name} не хватает монет на ставку`)
    const outcomes = gameHasOutcomes(node)
    const stake = outcomes ? 0 : g.stake ?? 0
    const mine = roll(6)
    const theirs = roll(6)
    const won = mine > theirs
    this.mark(`${at}:game#${played + 1}`)
    this.log(`${h.name} играет в кости: к6 = ${mine} против ${theirs} — ${won ? 'выигрыш!' : mine === theirs ? 'ничья, она за соперником.' : 'проигрыш.'}`, 'luck')
    if (outcomes) this.mark(`${at}:${won ? 'ok' : 'fail'}`)
    let applied: string | undefined
    if (stake && g.of === 'lives') {
      this.adjustLives(h.uid, won ? stake : -stake)
      applied = won ? `${h.name} получает ${stake} ${plural(stake, 'жизнь', 'жизни', 'жизней')} (теперь ${h.lives}).` : `${h.name} теряет ${stake} ${plural(stake, 'жизнь', 'жизни', 'жизней')} (осталось ${h.lives}).`
    } else if (stake) {
      this.adjustMoney(h.uid, won ? stake : -stake)
      applied = won ? `${h.name} выигрывает ${stake} ${plural(stake, 'монету', 'монеты', 'монет')} (всего ${h.money}).` : `${h.name} проигрывает ${stake} ${plural(stake, 'монету', 'монеты', 'монет')} (осталось ${h.money}).`
    }
    return { won, mine, theirs, ...(applied ? { applied } : {}) }
  }
  /** Снять отметку, если награду выдать не удалось (нет связи, герой убран) — иначе она пропала бы навсегда */
  unclaim(key: string): void {
    const claimed = this.state.claimed ?? []
    const i = claimed.indexOf(String(key))
    if (i >= 0) claimed.splice(i, 1)
  }
  trapFound(heroUid: string): void {
    const h = this.hero(heroUid)
    // стр. 10: «вор получает 400 очков» — за ловушку или потайную дверь опыт только вору
    if (h.classId !== 'thief') throw new GameError('Опыт за ловушки и потайные двери получает только вор')
    this.log(`${h.name} обнаруживает ловушку или потайную дверь: +${XP_TRAP_FOUND} опыта.`, 'xp')
    this.announceLevelUps(gainXp(h, XP_TRAP_FOUND, idx))
  }

  // ---------- спутники ----------
  addCompanion(monsterId: string, battles = 3): void {
    if (!idx.monsterById.has(monsterId)) throw new GameError('Нет такого монстра')
    battles = this.int(battles, 50)
    const m = idx.monster(monsterId)
    const sameKind = this.state.companions.filter((c) => c.monsterId === monsterId).length
    const c = { uid: uid('comp'), monsterId, name: sameKind ? `${m.name} ${sameKind + 1}` : m.name, lives: m.lives ?? 10, maxLives: m.lives ?? 10, battlesLeft: Math.max(1, Math.min(50, battles)) }
    this.state.companions.push(c)
    this.log(`К партии присоединяется спутник: ${c.name} (${c.battlesLeft} ${plural(c.battlesLeft, 'бой', 'боя', 'боёв')}).`)
  }
  dismissCompanion(companionUid: string): void {
    const c = this.state.companions.find((x) => x.uid === companionUid)
    this.state.companions = this.state.companions.filter((x) => x.uid !== companionUid)
    if (c) this.log(`${c.name} покидает партию.`)
  }

  // ---------- бой ----------
  /** Состав боя из команды: монстры из бестиария, разумное число (команду может прислать любой клиент). Предел — 60 на
   *  бой и на один вид: самая большая схватка книги — 60 орков (Крепость рыцарей, § 41) */
  private specs(specs: EncounterSpec[]): EncounterSpec[] {
    if (!Array.isArray(specs) || !specs.length || specs.length > 10) throw new GameError('Неверный состав боя')
    let total = 0
    for (const s of specs) {
      if (!idx.monsterById.has(String(s?.monsterId))) throw new GameError(`Нет такого монстра: ${s?.monsterId}`)
      const n = Number(s.count)
      if (!Number.isInteger(n) || n < 1 || n > MAX_FOES) throw new GameError('Неверное число монстров')
      total += n
    }
    if (total > MAX_FOES) throw new GameError('Слишком много монстров для одного боя')
    // только нужные поля: лишнее из сетевого запроса в бой не попадает
    return specs.map((s) => ({ monsterId: String(s.monsterId), count: Number(s.count) }))
  }
  /** place — этап книги, где начат бой: его итог отмечается при завершении боя и открывает исходы этапа */
  startEncounter(specs: EncounterSpec[], returnTo?: string, place?: string): void {
    specs = this.specs(specs)
    const at = place == null ? undefined : this.bookPlace(place)
    if (this.combat && !this.combat.finished) throw new GameError('Бой уже идёт')
    // прошлый бой окончен, но не закрыт: сначала подвести его итог (подобрать стрелы, засчитать бой спутникам, снять статусы)
    if (this.combat) this.endCombat()
    const { state, log: entries } = startCombat(specs, idx, returnTo)
    if (at) state.bookPlace = at
    // второе действие воина 12 уровня — и в раунде дистанции
    grantRoundActions(state, this.heroes, idx)
    const owner = this.heroes.find((h) => !h.status.dead)?.uid ?? ''
    for (const c of this.state.companions) {
      const m = idx.monster(c.monsterId)
      const table = Array.isArray(m.attacks) ? m.attacks.join('-') : '1-1-1-2-2-2'
      const ally = makeAlly(owner, c.name, m.defense ?? 10, table, c.lives)
      ally.maxLives = c.maxLives
      ally.companionUid = c.uid
      state.allies.push(ally)
    }
    this.state.combat = state
    this.logAll(entries)
    if (this.state.companions.length) this.log(`Вместе с героями сражаются: ${this.state.companions.map((c) => c.name).join(', ')}.`)
  }
  private requireCombat(): CombatState {
    if (!this.combat) throw new GameError('Бой не идёт')
    return this.combat
  }
  /** Ход героя в бою: только в ход героев, один раз за раунд (доп. действие не попадает в acted) и пока он на поле.
   *  Команды приходят по сети: двойной щелчок или устаревший экран не должны давать второе действие. */
  private requireHeroTurn(h: Hero): CombatState {
    const c = this.requireCombat()
    if (c.finished) throw new GameError('Бой уже окончен')
    if (c.turn !== 'heroes') throw new GameError('Сейчас ход монстров')
    if (c.escaped.includes(h.uid)) throw new GameError(`${h.name} уже покинул поле боя`)
    if (c.acted.includes(h.uid)) throw new GameError(`${h.name} уже сходил в этом раунде`)
    // без сознания, парализован, обездвижен, окаменел или очарован — ни удара, ни бегства, ни заклинания (команды и по сети)
    if (!isActive(h)) throw new GameError(`${h.name} сейчас не может действовать`)
    return c
  }
  attack(heroUid: string, slot: EquipSlot | 'unarmed' | 'spell', targetUid: string): void {
    const h = this.hero(heroUid)
    const out = heroAttack(this.requireHeroTurn(h), h, this.heroes, slot, targetUid, idx)
    this.logAll(out.log)
    this.announceLevelUps(out.levelUps)
  }
  cast(heroUid: string, spellId: string, opts: { targetUid?: string; targetHeroUid?: string; targetEntryUid?: string; param?: number; scrollUid?: string; monsterId?: string } = {}): CastResult {
    if (this.combat && !this.combat.finished) this.requireHeroTurn(this.hero(heroUid))
    // параметр приходит и по сети: только целое от 1 (иначе жизни и мана становятся NaN)
    if (opts.param !== undefined) {
      const p = Math.floor(Number(opts.param))
      opts = { ...opts, param: Number.isFinite(p) && p >= 1 ? Math.min(p, 999) : undefined }
    }
    const h = this.hero(heroUid)
    // прочесть по свитку (стр. 21): заклинание срабатывает один раз, свиток разрушается
    const scrollUid = opts.scrollUid
    const scroll = scrollUid ? h.inventory.find((e) => e.uid === scrollUid) : undefined
    if (scrollUid && (!scroll || scroll.kind !== 'scroll' || scroll.ref !== spellId || scroll.identified === false)) throw new GameError('Такого свитка у героя нет')
    // из присланного по сети — только цели и параметр: герой, партия и бой берутся из состояния, а не из запроса
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const res = castSpell({
      hero: h, spell: idx.spell(spellId), idx, heroes: this.heroes, combat: this.combat, fromScroll: !!scroll, flightReady: !!this.state.flight,
      targetUid: str(opts.targetUid), targetHeroUid: str(opts.targetHeroUid), targetEntryUid: str(opts.targetEntryUid), param: opts.param, monsterId: str(opts.monsterId),
    })
    if (res.ok && res.flight) this.state.flight = h.uid
    if (res.ok && scroll) {
      inv.removeFromInventory(h, scroll.uid, 1)
      res.log.push({ t: Date.now(), text: 'Свиток рассыпается в холодном белом огне.', kind: 'spell' })
    }
    this.logAll(res.log)
    this.announceLevelUps(res.levelUps)
    const c = this.combat
    if (res.ok && c && !c.finished && c.turn === 'heroes') {
      const h = this.hero(heroUid)
      // применение заклинания — действие за раунд
      if (!c.acted.includes(h.uid)) this.logAll(markActed(c, h, this.heroes, idx))
    }
    return res
  }
  flee(heroUid: string): void {
    const h = this.hero(heroUid)
    this.logAll(heroFlee(this.requireHeroTurn(h), h, this.heroes, idx))
  }
  skip(heroUid: string): void {
    const h = this.hero(heroUid)
    this.logAll(heroSkip(this.requireHeroTurn(h), h, this.heroes, idx))
  }
  toMelee(): void {
    const c = this.requireCombat()
    // повторное нажатие (двое игроков сразу) не перебрасывает инициативу и не начинает раунд заново
    if (c.finished || c.phase !== 'ranged' || c.turn !== 'heroes') return
    this.log(closeToMelee(c, this.heroes, idx).text)
  }
  monstersAct(): void {
    const c = this.requireCombat()
    if (c.turn !== 'monsters' || c.finished) return
    this.logAll(monstersTurn(c, this.heroes, idx))
    this.announceLevelUps(c.levelUps ?? [])
    delete c.levelUps
  }
  /** Забрать трофей с поля боя после победы */
  takeLoot(heroUid: string, lootUid: string): void {
    const h = this.hero(heroUid)
    if (h.status.dead) throw new GameError(`${h.name} мёртв`)
    let item
    try { item = takeLootItem(this.requireCombat(), lootUid) } catch (e) { throw new GameError((e as Error).message) }
    const entry = inv.addToInventory(h, item.kind, item.ref, 1)
    this.log(`${h.name} забирает трофей: ${inv.entryName(entry, idx)} (${item.from}).`)
  }
  endCombat(): void {
    const combat = this.requireCombat()
    if (!combat.finished) throw new GameError('Бой ещё идёт')
    // спутники: сохранить жизни, засчитать бой
    for (const a of combat.allies) {
      const c = a.companionUid ? this.state.companions.find((x) => x.uid === a.companionUid) : null
      if (!c) continue
      if (a.dead || a.lives <= 0) {
        this.state.companions = this.state.companions.filter((x) => x.uid !== c.uid)
        this.log(`${c.name} пал в бою.`, 'death')
        continue
      }
      c.lives = Math.min(c.maxLives, a.lives)
      // спутник служит, «пока вы не выиграете» оговорённое число схваток (стр. 16): бегство и поражение не засчитываются
      if (combat.finished !== 'victory') continue
      c.battlesLeft -= 1
      if (c.battlesLeft <= 0) {
        this.state.companions = this.state.companions.filter((x) => x.uid !== c.uid)
        this.log(`${c.name} выполнил уговор и уходит своей дорогой.`)
      }
    }
    if (combat.bookPlace) this.mark(`${combat.bookPlace}:${combat.finished === 'victory' ? 'won' : combat.finished === 'fled' ? 'fled' : 'lost'}`)
    this.logAll(finishCombat(combat, this.heroes, idx))
    this.state.combat = null
  }
  abortCombat(): void {
    const combat = this.requireCombat()
    // спутники сохраняют жизни (бой не засчитывается), боевые статусы и баффы снимаются
    for (const a of combat.allies) {
      const c = a.companionUid ? this.state.companions.find((x) => x.uid === a.companionUid) : null
      if (!c) continue
      if (a.dead || a.lives <= 0) this.state.companions = this.state.companions.filter((x) => x.uid !== c.uid)
      else c.lives = Math.min(c.maxLives, a.lives)
    }
    cleanupAfterCombat(this.heroes)
    this.state.combat = null
    this.log('Бой прерван вручную.')
  }
  endHeroesTurn(): void {
    this.logAll(endHeroesTurnEngine(this.requireCombat(), this.heroes, idx))
  }
  addMonstersToCombat(specs: EncounterSpec[]): void {
    const c = this.requireCombat()
    if (c.finished) throw new GameError('Бой уже окончен')
    const { state } = startCombat(this.specs(specs), idx)
    c.monsters.push(...state.monsters)
    this.log(`В бой вступают: ${state.monsters.map((m) => m.name).join(', ')}.`)
  }
}

/** Команды, которые можно вызывать по сети, и кто их вправе вызывать */
export type CommandRole =
  | 'owner' // действие конкретного героя: первым аргументом идёт uid героя игрока
  | 'party' // любое действие партии (путь, отдых, ход монстров)
  | 'gm' // решение ведущего (награды, проверки, бой из текста); при ИИ-ведущем — только его инструменты
  | 'host' // хозяин комнаты

export const COMMANDS = {
  note: 'party', setAllowDuplicateClasses: 'host', setStart: 'party',
  addHero: 'party', removeHero: 'owner', renameHero: 'owner',
  newGame: 'host', quickStart: 'host', toggleGm: 'host',
  buyItem: 'owner', sellItem: 'owner', equipItem: 'owner', unequipItem: 'owner', dropItem: 'owner', transferItem: 'owner',
  drink: 'owner', identifyBottle: 'owner', copyScroll: 'owner', learnSpell: 'owner', useAntidote: 'owner', useParalysisPotion: 'owner', poisonWeapon: 'owner',
  adjustLives: 'gm', adjustMana: 'gm', adjustMoney: 'gm', giveXp: 'gm', giveItem: 'gm',
  restAll: 'party', travelTo: 'party', enterLocation: 'party', leaveLocation: 'party', markVisited: 'party', dismissRoad: 'party',
  rollDie: 'party', rollDice: 'party', claim: 'gm', unclaim: 'gm', bookMark: 'gm', bookEffects: 'gm', luckCheck: 'gm', diceGame: 'gm', findArtifact: 'gm', giveScroll: 'gm', trapFound: 'gm', finalDuelAttack: 'gm', drinkFountain: 'gm',
  addCompanion: 'gm', dismissCompanion: 'party',
  startEncounter: 'gm', addMonstersToCombat: 'gm', abortCombat: 'gm',
  attack: 'owner', cast: 'owner', flee: 'owner', skip: 'owner',
  toMelee: 'party', monstersAct: 'party', endCombat: 'party', takeLoot: 'owner', endHeroesTurn: 'party',
} as const satisfies Record<string, CommandRole>

export type CommandName = keyof typeof COMMANDS
type Method<K extends CommandName> = GameSession[K] extends (...a: infer A) => infer R ? (...a: A) => R : never
export type CommandArgs<K extends CommandName> = Parameters<Method<K>>
export type CommandResult<K extends CommandName> = ReturnType<Method<K>>

/** Выполнить команду над сессией (общая точка для стора и сервера) */
export function runCommand<K extends CommandName>(session: GameSession, name: K, args: CommandArgs<K>): CommandResult<K> {
  const fn = session[name] as unknown as (...a: unknown[]) => CommandResult<K>
  return fn.apply(session, args as unknown[])
}
