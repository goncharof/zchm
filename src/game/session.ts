/**
 * Игровая сессия: все команды партии над сериализуемым GameState.
 * Один и тот же код выполняется в браузере (одиночная игра) и на сервере (сетевая игра).
 * Не зависит от Vue и от localStorage.
 */
import type { Caster, WorldMap } from '@/types'
import { gameData, idx } from '@/data'
import type { CombatState, EquipSlot, GameState, Hero, InventoryKind, LogEntry } from '@/engine/model'
import { SAVE_VERSION, uid } from '@/engine/model'
import { artifactSlot, changeLives, consumePrayer, createHero, gainXp, hasWard, heroLuck, isActive, isConscious, rest, type LevelUp } from '@/engine/character'
import * as inv from '@/engine/inventory'
import { k18, roll, rollFormula } from '@/engine/dice'
import { castSpell, type CastResult } from '@/engine/spells'
import { makeAlly, cleanupAfterCombat, heroRoll, endHeroesTurn as endHeroesTurnEngine, closeToMelee, finishCombat, heroAttack, heroFlee, heroSkip, markActed, monstersTurn, startCombat, type EncounterSpec } from '@/engine/combat'
import { rollRoadEncounters, shortestRoute } from '@/engine/world'
import { TROPHIES, takeLootItem } from '@/engine/loot'
import { plural } from '@/ui/format'
import { REST_COST_PER_DAY, REST_LIVES_PER_DAY, REST_MANA_PER_DAY, XP_ARTIFACT_FOUND, XP_TRAP_FOUND } from '@/engine/rules'

export const LOG_CAP = 500

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
  g.artifactsFound ??= []
  g.startNodeId ??= g.worldNodeId ?? 'zolotoy-gorod'
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
    this.state.log.push({ t: Date.now(), text, kind })
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
    const e = inv.buy(h, kind, ref, idx, this.qty(qty, 99))
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
    const e = inv.addToInventory(h, kind, ref, this.qty(qty), identified === undefined ? {} : { identified })
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
  restAll(days: number): void {
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
    const route = shortestRoute(this.world, this.state.worldNodeId, nodeId)
    if (!route) throw new GameError('Туда нет дороги')
    const allMounted = this.heroes.length > 0 && this.heroes.every((h) => h.inventory.some((e) => e.kind === 'item' && e.ref === 'kon'))
    const days = allMounted ? Math.ceil(route.days / 2) : route.days
    const road = idx.locationById.get('doroga')
    const encounters = rollRoadEncounters(days, road ? road.paragraphs.map((p) => p.n) : [])
    this.state.day += days
    this.state.worldNodeId = nodeId
    this.state.locationId = null
    this.state.pendingRoad.push(...encounters)
    const target = this.world.nodes.find((n) => n.id === nodeId)
    const legs = route.nodes.length - 1
    this.log(`Переход: ${legs} ${plural(legs, 'участок', 'участка', 'участков')} дороги, ${days} ${plural(days, 'день', 'дня', 'дней')} пути${allMounted ? ' верхом' : ''}. Прибытие — ${target?.name ?? nodeId}, день ${this.state.day}.${encounters.length ? ` В пути ${plural(encounters.length, 'случилась', 'случились', 'случилось')} ${encounters.length} ${plural(encounters.length, 'встреча', 'встречи', 'встреч')}: «Дорога», ${encounters.map((n) => `§ ${n}`).join(', ')}.` : ''}`)
  }
  enterLocation(locationId: string): void {
    if (!idx.locationById.has(locationId)) throw new GameError('Нет такой локации')
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
    try { r = rollFormula(String(formula).slice(0, 40)) } catch (e) { throw new GameError((e as Error).message) }
    this.log(`Бросок: ${formula} = ${r.total}${r.rolls.length > 1 ? ` (${r.rolls.join(' + ')})` : ''}.`, 'luck')
    return { total: r.total, rolls: r.rolls }
  }
  luckCheck(heroUid: string, target: number): { ok: boolean; roll: number; luck: number } {
    const h = this.hero(heroUid)
    target = this.int(target, 100)
    const blessing = hasWard(h, 'luck')
    if (blessing) {
      h.buffs = h.buffs.filter((b) => b !== blessing)
      this.log(`${h.name}: боги даруют удачу — проверка ${target} пройдена без броска.`, 'luck')
      return { ok: true, roll: 18, luck: heroLuck(h, idx) }
    }
    const prayer = consumePrayer(h)
    const r = heroRoll(h) + prayer
    const luck = heroLuck(h, idx)
    const ok = r + luck >= target
    this.log(`${h.name} бросает удачу ${target}: к18 = ${r}${luck ? ` + ${luck}` : ''} — ${ok ? 'удача!' : 'неудача'}.`, 'luck')
    return { ok, roll: r, luck }
  }
  findArtifact(heroUid: string): number | null {
    const h = this.hero(heroUid)
    let n = k18()
    // ХАУСРУЛ: уже найденный артефакт перебрасывается
    for (let i = 0; i < 18 && this.state.artifactsFound.includes(n); i++) n = k18()
    if (this.state.artifactsFound.includes(n)) throw new GameError('Все артефакты уже найдены')
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
      return true
    }
    const save = k18()
    const luck = heroLuck(h, idx)
    if (save + luck >= 11) {
      this.log(`Чёрный маг бросает огненный шар: ${h.name} уворачивается (к18 = ${save}${luck ? ` + ${luck}` : ''} ≥ 11).`, 'luck')
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
    // фонтаны книги: зал Чёрного мага (Замок, § 13) и фонтан Белого мага (Крепость короля назгулов, § 22)
    const at = (loc: string, n: number) => this.state.locationId === loc && (this.state.visited[loc] ?? []).includes(n)
    if (!at('zamok-chernogo-maga', 13) && !at('krepost-korolya-nazgulov', 22)) throw new GameError('Здесь нет фонтана')
    for (const h of this.heroes) {
      if (h.status.dead) continue
      changeLives(h, h.maxLives - h.lives)
      h.mana = h.maxMana
      delete h.status.poison
    }
    this.log('Команда пьёт из фонтана — все жизни и мана восстановлены.')
  }
  trapFound(heroUid: string): void {
    const h = this.hero(heroUid)
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
  /** Состав боя из команды: монстры из бестиария, разумное число (команду может прислать любой клиент) */
  private specs(specs: EncounterSpec[]): EncounterSpec[] {
    if (!Array.isArray(specs) || !specs.length || specs.length > 10) throw new GameError('Неверный состав боя')
    let total = 0
    for (const s of specs) {
      if (!idx.monsterById.has(String(s?.monsterId))) throw new GameError(`Нет такого монстра: ${s?.monsterId}`)
      const n = Number(s.count)
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new GameError('Неверное число монстров')
      total += n
    }
    if (total > 60) throw new GameError('Слишком много монстров для одного боя')
    return specs
  }
  startEncounter(specs: EncounterSpec[], returnTo?: string): void {
    specs = this.specs(specs)
    if (this.combat && !this.combat.finished) throw new GameError('Бой уже идёт')
    // прошлый бой окончен, но не закрыт: сначала подвести его итог (подобрать стрелы, засчитать бой спутникам, снять статусы)
    if (this.combat) this.endCombat()
    const { state, log: entries } = startCombat(specs, idx, returnTo)
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
  cast(heroUid: string, spellId: string, opts: { targetUid?: string; targetHeroUid?: string; targetEntryUid?: string; param?: number } = {}): CastResult {
    if (this.combat && !this.combat.finished) this.requireHeroTurn(this.hero(heroUid))
    // параметр приходит и по сети: только целое от 1 (иначе жизни и мана становятся NaN)
    if (opts.param !== undefined) {
      const p = Math.floor(Number(opts.param))
      opts = { ...opts, param: Number.isFinite(p) && p >= 1 ? Math.min(p, 999) : undefined }
    }
    const res = castSpell({ hero: this.hero(heroUid), spell: idx.spell(spellId), idx, heroes: this.heroes, combat: this.combat, ...opts })
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
      c.battlesLeft -= 1
      if (c.battlesLeft <= 0) {
        this.state.companions = this.state.companions.filter((x) => x.uid !== c.uid)
        this.log(`${c.name} выполнил уговор и уходит своей дорогой.`)
      }
    }
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
  rollDie: 'party', rollDice: 'party', luckCheck: 'gm', findArtifact: 'gm', giveScroll: 'gm', trapFound: 'gm', finalDuelAttack: 'gm', drinkFountain: 'gm',
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
