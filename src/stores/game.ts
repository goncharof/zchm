/** Главное хранилище: партия, мир, бой, журнал, сохранения. Вся механика — в src/engine. */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Caster, WorldMap } from '@/types'
import { gameData, idx, loadWorld } from '@/data'
import type { CombatState, EquipSlot, GameState, Hero, InventoryKind, LogEntry } from '@/engine/model'
import { SAVE_VERSION } from '@/engine/model'
import { changeLives, createHero, gainXp, hasWard, heroLuck, isConscious, rest, type LevelUp } from '@/engine/character'
import * as inv from '@/engine/inventory'
import { k18, roll, rollFormula } from '@/engine/dice'
import { castSpell, type CastResult } from '@/engine/spells'
import { closeToMelee, finishCombat, heroAttack, heroFlee, heroSkip, markActed, monstersTurn, startCombat, type EncounterSpec } from '@/engine/combat'
import { rollRoadEncounters, shortestRoute } from '@/engine/world'
import { plural } from '@/ui/format'
import { REST_COST_PER_DAY, REST_LIVES_PER_DAY, REST_MANA_PER_DAY, XP_ARTIFACT_FOUND, XP_TRAP_FOUND } from '@/engine/rules'

const SAVE_KEY = 'zchm.save.v1'
const LOG_CAP = 500

function blankGame(startNodeId = 'zolotoy-gorod'): GameState {
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
  }
}

function readSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const g = JSON.parse(raw) as GameState
    if (g.version !== SAVE_VERSION) return null
    return migrate(g)
  } catch {
    return null
  }
}

/** Дозаполняет поля, появившиеся в более новых версиях состояния */
function migrate(g: GameState): GameState {
  g.pendingRoad ??= []
  g.artifactsFound ??= []
  g.startNodeId ??= g.worldNodeId ?? 'zolotoy-gorod'
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
  }
  return g
}

export const useGameStore = defineStore('game', () => {
  const game = ref<GameState | null>(readSave())
  const world = ref<WorldMap | null>(null)
  const notice = ref<string>('')
  loadWorld().then((w) => { world.value = w })

  const heroes = computed<Hero[]>(() => game.value?.heroes ?? [])
  const combat = computed<CombatState | null>(() => game.value?.combat ?? null)
  const location = computed(() => (game.value?.locationId ? idx.locationById.get(game.value.locationId) ?? null : null))
  const worldNode = computed(() => world.value?.nodes.find((n) => n.id === game.value?.worldNodeId) ?? null)
  const started = computed(() => !!game.value && game.value.heroes.length > 0)

  watch(game, (g) => {
    if (!g) { localStorage.removeItem(SAVE_KEY); return }
    g.updatedAt = Date.now()
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(g)) } catch { /* переполнение хранилища — игнорируем */ }
  }, { deep: true })

  function log(text: string, kind: LogEntry['kind'] = 'info'): void {
    if (!game.value) return
    game.value.log.push({ t: Date.now(), text, kind })
    if (game.value.log.length > LOG_CAP) game.value.log.splice(0, game.value.log.length - LOG_CAP)
  }
  function logAll(entries: LogEntry[]): void {
    for (const e of entries) log(e.text, e.kind)
  }
  function say(text: string): void {
    notice.value = text
    setTimeout(() => { if (notice.value === text) notice.value = '' }, 4000)
  }
  function hero(uid: string): Hero {
    const h = heroes.value.find((x) => x.uid === uid)
    if (!h) throw new Error('Герой не найден')
    return h
  }
  function announceLevelUps(ups: LevelUp[]): void {
    for (const up of ups) {
      const h = hero(up.heroUid)
      const parts = [`жизни ${h.maxLives}`]
      if (h.maxMana) parts.push(`мана ${h.maxMana}`)
      if (up.bonus) parts.push(Object.entries(up.bonus).map(([k, v]) => `${({ strength: 'сила', dexterity: 'ловкость', accuracy: 'меткость', luck: 'удача', defense: 'защита' } as Record<string, string>)[k]} +${v}`).join(', '))
      if (up.special) parts.push(up.special)
      if (up.spellPick) parts.push('можно выбрать новое заклинание')
      log(`${h.name} достигает ${up.level} уровня: ${parts.join('; ')}.`, 'xp')
    }
  }

  // ---------- партия ----------
  function newGame(startNodeId?: string): void {
    game.value = blankGame(startNodeId)
    log('Новая партия. Каждый герой получает 40 монет на снаряжение.')
  }
  function addHero(name: string, classId: string): Hero {
    if (!game.value) newGame()
    const h = createHero(name, classId, idx)
    game.value!.heroes.push(h)
    log(`В команду вступает ${h.name} (${idx.cls(classId).name}).`)
    return h
  }
  function removeHero(uid: string): void {
    if (!game.value) return
    game.value.heroes = game.value.heroes.filter((h) => h.uid !== uid)
  }
  function renameHero(uid: string, name: string): void {
    hero(uid).name = name.trim() || hero(uid).name
  }
  function resetGame(): void {
    game.value = null
  }
  function exportSave(): string {
    return JSON.stringify(game.value, null, 1)
  }
  function importSave(text: string): void {
    const g = JSON.parse(text) as GameState
    if (!g || g.version !== SAVE_VERSION || !Array.isArray(g.heroes)) throw new Error('Это не сохранение игры')
    game.value = migrate(g)
  }
  function toggleGm(): void {
    if (game.value) game.value.gmMode = !game.value.gmMode
  }

  // ---------- лавка и вещи ----------
  function buyItem(heroUid: string, kind: 'weapon' | 'armor' | 'item', ref: string, qty = 1): void {
    const h = hero(heroUid)
    const e = inv.buy(h, kind, ref, idx, qty)
    log(`${h.name} покупает: ${inv.entryName(e, idx)}${qty > 1 ? ` ×${qty}` : ''}.`)
  }
  function sellItem(heroUid: string, entryUid: string, qty = 1): void {
    const h = hero(heroUid)
    const e = h.inventory.find((x) => x.uid === entryUid)
    const name = e ? inv.entryName(e, idx) : ''
    const gain = inv.sell(h, entryUid, idx, qty)
    log(`${h.name} продаёт ${name} за ${gain} монет.`)
  }
  function equipItem(heroUid: string, entryUid: string, slot?: EquipSlot): void {
    const h = hero(heroUid)
    inv.equip(h, entryUid, idx, slot)
  }
  function unequipItem(heroUid: string, slot: EquipSlot): void {
    inv.unequip(hero(heroUid), slot)
  }
  function giveItem(heroUid: string, kind: InventoryKind, ref: string, qty = 1, identified?: boolean): void {
    const h = hero(heroUid)
    const e = inv.addToInventory(h, kind, ref, qty, identified === undefined ? {} : { identified })
    log(`${h.name} получает: ${inv.entryName(e, idx)}${qty > 1 ? ` ×${qty}` : ''}.`)
  }
  function dropItem(heroUid: string, entryUid: string, qty = 1): void {
    inv.removeFromInventory(hero(heroUid), entryUid, qty)
  }
  function transferItem(fromUid: string, toUid: string, entryUid: string): void {
    const from = hero(fromUid)
    const to = hero(toUid)
    const e = from.inventory.find((x) => x.uid === entryUid)
    if (!e) return
    inv.removeFromInventory(from, entryUid, e.qty)
    to.inventory.push({ ...e })
    log(`${from.name} передаёт ${inv.entryName(e, idx)} — ${to.name}.`)
  }
  function drink(heroUid: string, entryUid: string): void {
    const h = hero(heroUid)
    const r = inv.drinkBottle(h, entryUid, idx)
    log(`${h.name} пьёт из бутылки (${r.n}). ${r.text}`, r.died ? 'death' : 'info')
  }
  function identifyBottle(heroUid: string, entryUid: string): void {
    // распознаватель напитков (стр. 21): ошибается с вероятностью 1/6
    const h = hero(heroUid)
    const e = h.inventory.find((x) => x.uid === entryUid)
    if (!e || e.kind !== 'bottle') return
    const has = heroes.value.some((x) => x.inventory.some((i) => i.kind === 'item' && i.ref === 'raspoznavatel-napitkov'))
    if (!has) { say('Нужен распознаватель напитков'); return }
    const n = parseInt(e.ref, 10)
    const good = n >= 4
    const wrong = roll(6) === 1
    log(`${h.name} проверяет бутылку распознавателем: ${(good !== wrong) ? 'напиток безопасен' : 'опасно — не пейте'}.${wrong ? '' : ''}`)
    if (!wrong) e.identified = true
  }
  function copyScroll(heroUid: string, entryUid: string): void {
    const h = hero(heroUid)
    log(`${h.name}: ${inv.copyScroll(h, entryUid, idx)}`, 'spell')
  }
  function learnSpell(heroUid: string, spellId: string): void {
    const h = hero(heroUid)
    const s = idx.spell(spellId)
    if (h.pendingSpellPicks <= 0) throw new Error('Нет доступных выборов заклинаний')
    if (s.level > h.level) throw new Error('Уровень заклинания выше уровня персонажа')
    if (h.spellbook.includes(spellId)) throw new Error('Уже в книге')
    h.spellbook.push(spellId)
    h.pendingSpellPicks -= 1
    log(`${h.name} записывает в книгу заклинание «${s.name}».`, 'spell')
  }
  function useAntidote(ownerUid: string, targetUid: string): void {
    inv.useAntidote(hero(targetUid), hero(ownerUid), idx)
    log(`${hero(targetUid).name} принимает противоядие.`)
  }
  function useParalysisPotion(ownerUid: string, targetUid: string): void {
    inv.useParalysisPotion(hero(targetUid), hero(ownerUid), idx)
    log(`${hero(ownerUid).name} даёт зелье от паралича — ${hero(targetUid).name} снова может двигаться.`)
  }
  function poisonWeapon(heroUid: string, weaponUid: string): void {
    inv.poisonWeapon(hero(heroUid), weaponUid, idx)
    log(`${hero(heroUid).name} смазывает оружие ядом.`)
  }
  function adjustLives(heroUid: string, delta: number): void {
    const h = hero(heroUid)
    const before = h.lives
    changeLives(h, delta)
    log(`${h.name}: жизни ${before} → ${h.lives}.`, delta < 0 ? 'damage' : 'info')
  }
  function adjustMana(heroUid: string, delta: number): void {
    const h = hero(heroUid)
    h.mana = Math.max(0, Math.min(h.maxMana, h.mana + delta))
  }
  function adjustMoney(heroUid: string, delta: number): void {
    const h = hero(heroUid)
    h.money = Math.max(0, h.money + delta)
    log(`${h.name}: ${delta >= 0 ? '+' : ''}${delta} монет (всего ${h.money}).`)
  }
  function giveXp(heroUid: string, amount: number): void {
    const h = hero(heroUid)
    announceLevelUps(gainXp(h, amount, idx))
    log(`${h.name} получает ${amount} очков опыта.`, 'xp')
  }

  // ---------- трактир ----------
  function restAll(days: number): void {
    if (!game.value) return
    for (const h of heroes.value) {
      const r = rest(h, days, REST_COST_PER_DAY, REST_LIVES_PER_DAY, REST_MANA_PER_DAY)
      if (r.days < days) log(`${h.name} может оплатить только ${r.days} сут. из ${days}.`)
    }
    game.value.day += days
    log(`Команда отдыхает в трактире: ${days} ${plural(days, 'сутки', 'суток', 'суток')} (2 монеты в сутки с каждого; +5 жизней и +5 маны в сутки). День ${game.value.day}.`)
  }

  // ---------- мир и локации ----------
  function travelTo(nodeId: string): void {
    if (!game.value || !world.value || !game.value.worldNodeId) return
    const route = shortestRoute(world.value, game.value.worldNodeId, nodeId)
    if (!route) { say('Туда нет дороги'); return }
    const allMounted = heroes.value.length > 0 && heroes.value.every((h) => h.inventory.some((e) => e.kind === 'item' && e.ref === 'kon'))
    const days = allMounted ? Math.ceil(route.days / 2) : route.days
    const road = idx.locationById.get('doroga')
    const encounters = rollRoadEncounters(days, road ? road.paragraphs.map((p) => p.n) : [])
    game.value.day += days
    game.value.worldNodeId = nodeId
    game.value.locationId = null
    game.value.pendingRoad.push(...encounters)
    const target = world.value.nodes.find((n) => n.id === nodeId)
    const legs = route.nodes.length - 1
    log(`Переход: ${legs} ${plural(legs, 'участок', 'участка', 'участков')} дороги, ${days} ${plural(days, 'день', 'дня', 'дней')} пути${allMounted ? ' верхом' : ''}. Прибытие — ${target?.name ?? nodeId}, день ${game.value.day}.${encounters.length ? ` В пути ${plural(encounters.length, 'случилась', 'случились', 'случилось')} ${encounters.length} ${plural(encounters.length, 'встреча', 'встречи', 'встреч')}: «Дорога», ${encounters.map((n) => `§ ${n}`).join(', ')}.` : ''}`)
  }
  function enterLocation(locationId: string): void {
    if (!game.value) return
    game.value.locationId = locationId
    log(`Партия входит: ${idx.locationById.get(locationId)?.name ?? locationId}.`)
  }
  function leaveLocation(): void {
    if (game.value) game.value.locationId = null
  }
  function markVisited(locationId: string, n: number): void {
    if (!game.value) return
    const arr = (game.value.visited[locationId] ??= [])
    if (!arr.includes(n)) arr.push(n)
  }
  function dismissRoad(n: number): void {
    if (!game.value) return
    const i = game.value.pendingRoad.indexOf(n)
    if (i >= 0) game.value.pendingRoad.splice(i, 1)
  }

  // ---------- действия по параграфу ----------
  function rollDie(sides: number, context?: string): number {
    const r = roll(sides)
    log(`${context ? `${context}: ` : ''}к${sides} = ${r}.`, 'luck')
    return r
  }
  function luckCheck(heroUid: string, target: number): { ok: boolean; roll: number; luck: number } {
    const h = hero(heroUid)
    const blessing = hasWard(h, 'luck')
    if (blessing) {
      h.buffs = h.buffs.filter((b) => b !== blessing)
      log(`${h.name}: боги даруют удачу — проверка ${target} пройдена без броска.`, 'luck')
      return { ok: true, roll: 18, luck: heroLuck(h, idx) }
    }
    const r = k18()
    const luck = heroLuck(h, idx)
    const ok = r + luck >= target
    log(`${h.name} бросает удачу ${target}: к18 = ${r}${luck ? ` + ${luck}` : ''} — ${ok ? 'удача!' : 'неудача'}.`, 'luck')
    return { ok, roll: r, luck }
  }
  function findArtifact(heroUid: string): number | null {
    if (!game.value) return null
    const h = hero(heroUid)
    let n = k18()
    // ХАУСРУЛ: уже найденный артефакт перебрасывается
    for (let i = 0; i < 18 && game.value.artifactsFound.includes(n); i++) n = k18()
    if (game.value.artifactsFound.includes(n)) { say('Все артефакты уже найдены'); return null }
    game.value.artifactsFound.push(n)
    const a = idx.artifact(n)
    inv.addToInventory(h, 'artifact', String(n))
    log(`Артефакт! к18 = ${n}: ${a.name}. ${h.name} берёт его. Все получают ${XP_ARTIFACT_FOUND} очков опыта.`, 'xp')
    for (const x of heroes.value) if (isConscious(x)) announceLevelUps(gainXp(x, XP_ARTIFACT_FOUND, idx))
    return n
  }
  function giveScroll(heroUid: string, caster?: Caster, level?: number): void {
    const h = hero(heroUid)
    const c: Caster = caster ?? (roll(2) === 1 ? 'mage' : 'priest')
    const pool = gameData.spells.filter((s) => s.caster === c && (level === undefined ? s.level > 0 : s.level === level))
    if (!pool.length) { say('Нет подходящего заклинания'); return }
    const s = pool[roll(pool.length) - 1]
    inv.addToInventory(h, 'scroll', s.id, 1, { identified: true })
    log(`${h.name} получает свиток: «${s.name}» (${c === 'mage' ? 'маг' : 'жрец'}, ${s.level} ур.).`, 'spell')
  }
  /**
   * Финал (Замок Чёрного мага, §13): попасть в мага — удача 15; при промахе маг бросает огненный шар
   * (удача 11, иначе −1к18 жизней — ХАУСРУЛ: урон шара в книге не указан). Попадание — победа,
   * корона (1000 монет) и артефакт.
   */
  function finalDuelAttack(heroUid: string): boolean {
    if (!game.value) return false
    const h = hero(heroUid)
    const r = luckCheck(heroUid, 15)
    if (r.ok) {
      log(`${h.name} поражает Чёрного мага! Маг исчезает — на его месте кучка пепла, корона и артефакт. Долина Тмамрак не войдёт в наш мир.`, 'xp')
      h.money += 1000
      log(`${h.name} забирает корону Чёрного мага (1000 монет).`)
      findArtifact(heroUid)
      game.value.victory = { day: game.value.day, heroUid, heroName: h.name }
      return true
    }
    const save = k18()
    const luck = heroLuck(h, idx)
    if (save + luck >= 11) {
      log(`Чёрный маг бросает огненный шар: ${h.name} уворачивается (к18 = ${save}${luck ? ` + ${luck}` : ''} ≥ 11).`, 'luck')
    } else {
      const dmg = rollFormula('1к18').total
      const lost = -changeLives(h, -dmg)
      log(`Чёрный маг бросает огненный шар: ${h.name} не успевает увернуться (к18 = ${save}${luck ? ` + ${luck}` : ''} < 11) и теряет ${lost} жизней.`, 'damage')
      if (h.status.dead) log(`${h.name} погибает.`, 'death')
      else if (h.status.unconscious) log(`${h.name} теряет сознание.`, 'death')
    }
    return false
  }
  function drinkFountain(): void {
    for (const h of heroes.value) {
      if (h.status.dead) continue
      changeLives(h, h.maxLives - h.lives)
      h.mana = h.maxMana
      delete h.status.poison
    }
    log('Команда пьёт из фонтана — все жизни и мана восстановлены.')
  }
  function trapFound(heroUid: string): void {
    const h = hero(heroUid)
    log(`${h.name} обнаруживает ловушку или потайную дверь: +${XP_TRAP_FOUND} опыта.`, 'xp')
    announceLevelUps(gainXp(h, XP_TRAP_FOUND, idx))
  }

  // ---------- бой ----------
  function startEncounter(specs: EncounterSpec[], returnTo?: string): void {
    if (!game.value) return
    const { state, log: entries } = startCombat(specs, idx, returnTo)
    game.value.combat = state
    logAll(entries)
  }
  function attack(heroUid: string, slot: EquipSlot | 'unarmed' | 'spell', targetUid: string): void {
    const c = combat.value
    if (!c) return
    const out = heroAttack(c, hero(heroUid), heroes.value, slot, targetUid, idx)
    logAll(out.log)
    announceLevelUps(out.levelUps)
  }
  function cast(heroUid: string, spellId: string, opts: { targetUid?: string; targetHeroUid?: string; targetEntryUid?: string; param?: number } = {}): CastResult {
    const res = castSpell({ hero: hero(heroUid), spell: idx.spell(spellId), idx, heroes: heroes.value, combat: combat.value, ...opts })
    logAll(res.log)
    announceLevelUps(res.levelUps)
    if (res.ok && combat.value && !combat.value.finished && combat.value.turn === 'heroes') {
      const h = hero(heroUid)
      if (!combat.value.acted.includes(h.uid)) {
        // применение заклинания — действие за раунд
        logAll(markActed(combat.value, h, heroes.value, idx))
      }
    }
    return res
  }
  function flee(heroUid: string): void {
    if (!combat.value) return
    logAll(heroFlee(combat.value, hero(heroUid), heroes.value, idx))
  }
  function skip(heroUid: string): void {
    if (!combat.value) return
    logAll(heroSkip(combat.value, hero(heroUid), heroes.value, idx))
  }
  function toMelee(): void {
    if (!combat.value) return
    log(closeToMelee(combat.value, heroes.value, idx).text)
  }
  function monstersAct(): void {
    if (!combat.value) return
    logAll(monstersTurn(combat.value, heroes.value, idx))
  }
  function endCombat(): void {
    if (!game.value || !game.value.combat) return
    logAll(finishCombat(game.value.combat, heroes.value, idx))
    game.value.combat = null
  }
  function abortCombat(): void {
    if (!game.value) return
    game.value.combat = null
    log('Бой прерван вручную.')
  }
  function addMonstersToCombat(specs: EncounterSpec[]): void {
    const c = combat.value
    if (!c) return
    const { state } = startCombat(specs, idx)
    c.monsters.push(...state.monsters)
    log(`В бой вступают: ${state.monsters.map((m) => m.name).join(', ')}.`)
  }

  return {
    game, world, notice, heroes, combat, location, worldNode, started,
    log, say, hero,
    newGame, addHero, removeHero, renameHero, resetGame, exportSave, importSave, toggleGm,
    buyItem, sellItem, equipItem, unequipItem, giveItem, dropItem, transferItem, drink, identifyBottle, copyScroll, learnSpell,
    useAntidote, useParalysisPotion, poisonWeapon, adjustLives, adjustMana, adjustMoney, giveXp,
    restAll, travelTo, enterLocation, leaveLocation, markVisited, dismissRoad,
    rollDie, luckCheck, findArtifact, giveScroll, trapFound, finalDuelAttack, drinkFountain,
    startEncounter, attack, cast, flee, skip, toMelee, monstersAct, endCombat, abortCombat, addMonstersToCombat,
  }
})
