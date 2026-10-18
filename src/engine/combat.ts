/** Бой (стр. 17–19 Инструкции): раунды, инициатива, атаки, храбрость, доп. атаки, бегство, союзники, магия монстров. */
import type { Monster, Spell } from '@/types'
import type { DataIndex } from './data'
import type { AllyInstance, Buff, CombatState, EquipSlot, Hero, LogEntry, MonsterInstance } from './model'
import { uid } from './model'
import { changeLives, consumePrayer, gainXp, hasWard, heroAccuracy, heroDefense, heroDexterity, heroLuck, heroStrength, heroWeapons, isActive, isConscious, levelRow, UNARMED, type HandWeapon, type LevelUp } from './character'
import { k18, k6, roll, rollAttackTable, rollFormula } from './dice'
import { EXTRA_ATTACKS, fleeTarget } from './rules'
import { rollSpellDamage } from './spells'
import { addToInventory, entryName, removeFromInventory } from './inventory'
import { collectLoot } from './loot'

export interface EncounterSpec {
  monsterId: string
  count: number
}

/** Немёртвые: на них действуют «Отворот мертвецов» и «Уничтожение мертвецов» */
export const UNDEAD = new Set(['zombi', 'skelet', 'vampir', 'umertvie', 'upyr', 'vurdalak', 'mogilnik', 'rytsar-smerti', 'fantom', 'duh', 'ten', 'smert', 'kolesnitsa-smerti', 'zhnets'])

export function entry(text: string, kind: LogEntry['kind'] = 'info'): LogEntry {
  return { t: Date.now(), text, kind }
}

export function makeMonsterInstance(m: Monster, n: number): MonsterInstance {
  const attacks = Array.isArray(m.attacks) ? m.attacks : m.attacks === 'death' || m.attacks === 'magic' || m.attacks === 'none' ? m.attacks : [1, 1, 1, 2, 2, 2]
  return {
    uid: uid('mon'),
    monsterId: m.id,
    name: n > 1 ? `${m.name} ${n}` : m.name,
    level: m.level ?? 1,
    lives: m.lives ?? 10,
    maxLives: m.lives ?? 10,
    defense: m.defense ?? 10,
    attacks,
    courage: typeof m.courage === 'number' ? m.courage : null,
    points: m.points ?? 10,
    extraAttacks: m.extraAttacks,
    mana: m.mana,
    // ХАУСРУЛ: «атаки — магия» без списка заклинаний (Белый маг) — боевые заклинания мага
    spells: m.spells?.length ? m.spells : m.attacks === 'magic' ? ['Огненное копье', 'Ледяная молния'] : undefined,
    courageChecked: false,
    fled: false,
    dead: false,
    defenseMod: 0,
    attackMod: 0,
    attackMultiplier: 1,
  }
}

/** ХАУСРУЛ: каждая голова Гидры — отдельный противник со своими жизнями и атакой */
export function makeHeads(m: Monster, n: number): MonsterInstance[] {
  const groupId = uid('grp')
  const out: MonsterInstance[] = []
  for (let h = 1; h <= (m.heads ?? 1); h++) {
    const inst = makeMonsterInstance(m, 0)
    inst.name = `${m.name}${n ? ` ${n}` : ''}, голова ${h}`
    inst.lives = inst.maxLives = m.livesPerHead ?? 1
    inst.groupId = groupId
    out.push(inst)
  }
  return out
}

/** В конце раунда у Гидры на месте одной отрубленной головы вырастает новая (без опыта за неё) */
export function regrowHeads(state: CombatState): LogEntry[] {
  const log: LogEntry[] = []
  const groups = new Map<string, MonsterInstance[]>()
  for (const m of state.monsters) if (m.groupId) groups.set(m.groupId, [...(groups.get(m.groupId) ?? []), m])
  for (const heads of groups.values()) {
    const alive = heads.filter((h) => !h.dead && !h.fled)
    const cut = heads.filter((h) => h.dead)
    if (!alive.length || !cut.length) continue
    const head = cut[0]
    head.dead = false
    head.lives = head.maxLives
    head.points = 0
    head.disabled = 0
    head.petrified = false
    log.push(entry(`На месте отрубленной головы вырастает новая: ${head.name}.`, 'hit'))
  }
  return log
}

export function makeAlly(ownerUid: string, name: string, defense: number, attacks: string, lives: number, rounds = -1, decoy = false): AllyInstance {
  return { uid: uid('ally'), ownerUid, name, defense, attacks, lives, maxLives: lives, rounds, decoy, attackMultiplier: 1 }
}

export function startCombat(specs: EncounterSpec[], idx: DataIndex, returnTo?: string): { state: CombatState; log: LogEntry[] } {
  const monsters: MonsterInstance[] = []
  for (const s of specs) {
    const m = idx.monster(s.monsterId)
    for (let i = 1; i <= s.count; i++) {
      if (m.regrows && m.heads && m.livesPerHead) monsters.push(...makeHeads(m, s.count > 1 ? i : 0))
      else monsters.push(makeMonsterInstance(m, s.count > 1 ? i : 0))
    }
  }
  const state: CombatState = {
    round: 1,
    phase: 'ranged',
    turn: 'heroes',
    monsters,
    allies: [],
    acted: [],
    extraActions: {},
    escaped: [],
    recover: {},
    returnTo,
    xpEarned: {},
  }
  const log = [entry(`Бой начинается: ${monsters.map((m) => m.name).join(', ')}. Первый раунд — дистанция: метательное оружие и заклинания.`)]
  return { state, log }
}

/** Дополнительные действия в раунде: воин 12 уровня — 2 атаки за ход */
export function grantRoundActions(state: CombatState, heroes: Hero[], idx: DataIndex): void {
  state.extraActions = {}
  for (const h of heroes) {
    if (h.level >= 12 && idx.cls(h.classId).id === 'warrior') state.extraActions[h.uid] = 1
  }
}

/** ХАУСРУЛ: монстр, знающий «Инициативу», произносит её, когда стороны сходятся (если хватает маны) */
function monsterInitiative(state: CombatState, idx: DataIndex): MonsterInstance | null {
  const spell = idx.data.spells.find((s) => s.effect.type === 'initiative')
  if (!spell) return null
  const cost = typeof spell.cost === 'number' ? spell.cost : 1
  const name = normName(spell.name)
  const m = aliveMonsters(state).find((x) => !x.disabled && !x.petrified && (x.mana ?? 0) >= cost && (x.spells ?? []).some((n) => normName(n) === name))
  if (m) m.mana = (m.mana ?? 0) - cost
  return m ?? null
}

/** Бросок инициативы перед ближним боем: к18 с каждой стороны, при равенстве перебрасывается.
 *  Вор 12 уровня «всегда атакует первым»; заклинание «Инициатива» даёт то же на один бой.
 *  ХАУСРУЛ: если инициатива есть у обеих сторон, они гасят друг друга и бросается обычный к18. */
export function rollInitiative(state: CombatState, heroes: Hero[], idx?: DataIndex): LogEntry {
  const auto = heroes.find((h) => !state.escaped.includes(h.uid) && isConscious(h) && (h.status.initiative || (h.level >= 12 && idx?.cls(h.classId).id === 'thief')))
  const caster = idx ? monsterInitiative(state, idx) : null
  if (auto) delete auto.status.initiative
  if (auto && !caster) {
    state.initiative = { heroes: 18, monsters: 0 }
    state.turn = 'heroes'
    return entry(`${auto.name} атакует первым — инициатива у героев.`)
  }
  if (caster && !auto) {
    state.initiative = { heroes: 0, monsters: 18 }
    state.turn = 'monsters'
    return entry(`${caster.name} произносит «Инициатива» — первыми атакуют монстры.`, 'spell')
  }
  const both = auto && caster ? `${auto.name} и ${caster.name} («Инициатива») готовы ударить первыми — решает бросок. ` : ''
  let h = k18()
  let m = k18()
  while (h === m) {
    h = k18()
    m = k18()
  }
  state.initiative = { heroes: h, monsters: m }
  state.turn = h > m ? 'heroes' : 'monsters'
  return entry(`${both}Инициатива: команда ${h}, монстры ${m} — первыми атакуют ${h > m ? 'герои' : 'монстры'}.`)
}

export function aliveMonsters(state: CombatState): MonsterInstance[] {
  return state.monsters.filter((m) => !m.dead && !m.fled)
}

export function aliveAllies(state: CombatState): AllyInstance[] {
  return state.allies.filter((a) => !a.dead)
}

export function fightingHeroes(heroes: Hero[], state: CombatState): Hero[] {
  return heroes.filter((h) => !state.escaped.includes(h.uid) && isConscious(h))
}

export function activeHeroes(heroes: Hero[], state: CombatState): Hero[] {
  return heroes.filter((h) => !state.escaped.includes(h.uid) && isActive(h))
}

export function damageMonster(m: MonsterInstance, amount: number): { dealt: number; killed: boolean } {
  const dealt = Math.max(0, Math.min(amount, Math.max(0, m.lives)))
  m.lives -= Math.max(0, amount)
  if (m.lives <= 0) m.dead = true
  return { dealt, killed: m.dead }
}

export function awardXp(state: CombatState, hero: Hero, dealt: number, m: MonsterInstance, idx: DataIndex): { xp: number; levelUps: LevelUp[] } {
  const xp = dealt * m.points
  if (xp <= 0) return { xp: 0, levelUps: [] }
  state.xpEarned[hero.uid] = (state.xpEarned[hero.uid] ?? 0) + xp
  return { xp, levelUps: gainXp(hero, xp, idx) }
}

export interface AttackOutcome {
  log: LogEntry[]
  hit: boolean
  damage: number
  killed: boolean
  xp: number
  levelUps: LevelUp[]
}

/** Число на к18, нужное герою для попадания выбранным оружием */
export function toHit(hero: Hero, w: HandWeapon | null, target: MonsterInstance, idx: DataIndex): number {
  const bonus = w?.ranged ? heroAccuracy(hero, idx) + (w.accuracyBonus ?? 0) : heroDexterity(hero) + (w?.dexterityBonus ?? 0)
  return target.defense + target.defenseMod - bonus
}

/** Атака героя оружием (слот), магическим оружием ('spell') или без оружия */
export function heroAttack(state: CombatState, hero: Hero, heroes: Hero[], weaponSlot: EquipSlot | 'unarmed' | 'spell', targetUid: string, idx: DataIndex): AttackOutcome {
  const out: AttackOutcome = { log: [], hit: false, damage: 0, killed: false, xp: 0, levelUps: [] }
  const target = aliveMonsters(state).find((m) => m.uid === targetUid)
  if (!target) { out.log.push(entry('Цель не найдена')); return out }
  if (!isActive(hero)) { out.log.push(entry(`${hero.name} не может действовать`)); return out }
  const weapons = heroWeapons(hero, idx)
  const w: HandWeapon | null = weaponSlot === 'unarmed' ? null : weapons.find((x) => x.slot === weaponSlot) ?? null
  const ranged = !!w?.ranged
  if (state.phase === 'ranged' && !ranged) {
    out.log.push(entry('На дистанции можно только стрелять или колдовать. Переходите в ближний бой.'))
    return out
  }
  if (state.phase === 'melee' && ranged && !w?.thrown) {
    // ХАУСРУЛ: луки и арбалеты в ближнем бою не используются; дротики и копья — можно
    out.log.push(entry('Противник вплотную — из лука уже не выстрелить.'))
    return out
  }
  if (w?.needsAmmo && !w.ammoEntry) {
    out.log.push(entry(`${hero.name}: стрелы кончились.`))
    return out
  }
  const name = w?.name ?? 'голые руки'
  const prayer = consumePrayer(hero)
  if (prayer) out.log.push(entry(`${hero.name}: молитва услышана, +${prayer} к броску.`, 'spell'))
  const bonus = (ranged ? heroAccuracy(hero, idx) + (w?.accuracyBonus ?? 0) : heroDexterity(hero) + (w?.dexterityBonus ?? 0)) + prayer
  const need = target.defense + target.defenseMod
  const helpless = (target.disabled ?? 0) > 0 || target.petrified
  const swings = w?.attacksPerRound ?? 1
  for (let swing = 0; swing < swings; swing++) {
    // расход боеприпасов: стрела улетает, дротик или копьё ложится на поле боя
    let arrowRef: string | undefined
    if (w?.needsAmmo && w.ammoEntry) {
      arrowRef = w.ammoEntry.ref
      removeFromInventory(hero, w.ammoEntry.uid, 1)
    }
    if (w?.thrown && w.entry) {
      addRecover(state, hero.uid, w.entry.ref, 1)
      removeFromInventory(hero, w.entry.uid, 1)
    }
    const r = heroRoll(hero)
    // ХАУСРУЛ: по спящему, парализованному или окаменевшему противнику попадают автоматически
    const hit = w?.alwaysHits || helpless || r + bonus >= need
    out.log.push(entry(`${hero.name} атакует ${target.name} (${name}): к18 = ${r}${bonus ? ` + ${bonus}` : ''} против защиты ${need} — ${hit ? (helpless ? 'беззащитная цель, попадание' : 'попадание') : 'промах'}.`, hit ? 'hit' : 'miss'))
    if (!hit) continue
    out.hit = true
    // ХАУСРУЛ: попавшие стрелы можно подобрать после победы, промахнувшиеся теряются
    if (arrowRef) addRecover(state, hero.uid, arrowRef, 1)
    let total = 0
    const parts: string[] = []
    const rollsCount = w?.doubleDamage ? 2 : 1
    for (let i = 0; i < rollsCount; i++) {
      // под «Несчастьем» урон тоже бросается дважды, берётся меньший
      if (w?.formula) {
        let f = rollFormula(w.formula)
        if (hero.status.cursed) { const g = rollFormula(w.formula); if (g.total < f.total) f = g }
        total += f.total
        parts.push(`${w.formula} = ${f.total}`)
      } else {
        let a = rollAttackTable(w?.attacks ?? UNARMED)
        if (hero.status.cursed) { const b = rollAttackTable(w?.attacks ?? UNARMED); if (b.damage < a.damage) a = b }
        total += a.damage
        parts.push(`к6 = ${a.roll} → ${a.damage}`)
      }
    }
    if (!ranged) {
      const s = heroStrength(hero, idx)
      if (s) { total += s; parts.push(`сила +${s}`) }
    }
    const cls = idx.cls(hero.classId)
    if (hero.level >= 12 && cls.id === 'barbarian') { total *= 2; parts.push('варвар 12 ур. ×2') }
    for (const b of hero.buffs.filter((x) => x.stat === 'attacks')) {
      if (b.multiplier) { total = Math.floor(total * b.amount); parts.push(`${b.source} ×${b.amount}`) }
      else { total += b.amount; parts.push(`${b.source} ${b.amount >= 0 ? '+' : ''}${b.amount}`) }
    }
    if (w?.poisoned && w.entry) {
      const p = rollFormula('1к18')
      total += p.total
      const rounds = k6()
      target.poison = (target.poison ?? 0) + rounds
      target.dotBy = { ...target.dotBy, poison: hero.uid }
      w.entry.poisoned = false
      parts.push(`яд +${p.total}, действует ${rounds} раунд(ов)`)
    }
    const d = damageMonster(target, total)
    out.damage += d.dealt
    out.killed = d.killed
    const xp = awardXp(state, hero, d.dealt, target, idx)
    out.xp += xp.xp
    out.levelUps.push(...xp.levelUps)
    out.log.push(entry(`${target.name} теряет ${d.dealt} жизней (${parts.join(', ')}).${d.killed ? ` ${target.name} повержен!` : ` Осталось ${Math.max(0, target.lives)}.`}`, d.killed ? 'death' : 'damage'))
    if (w?.lifesteal && d.dealt > 0) {
      const healed = changeLives(hero, d.dealt)
      if (healed > 0) out.log.push(entry(`${name} возвращает ${hero.name} ${healed} жизней.`, 'spell'))
    }
    if (xp.xp) out.log.push(entry(`${hero.name} получает ${xp.xp} очков опыта.`, 'xp'))
    for (const up of xp.levelUps) out.log.push(entry(`${hero.name} достигает ${up.level} уровня!`, 'xp'))
    if (d.killed) break
  }
  out.log.push(...markActed(state, hero, heroes, idx))
  return out
}

export function addRecover(state: CombatState, heroUid: string, ref: string, n: number): void {
  const bag = (state.recover[heroUid] ??= {})
  bag[ref] = (bag[ref] ?? 0) + n
}

/** Попытка бегства: к18 против таблицы по уровню самого сильного монстра */
export function heroFlee(state: CombatState, hero: Hero, heroes: Hero[], idx: DataIndex): LogEntry[] {
  const maxLevel = Math.max(1, ...aliveMonsters(state).map((m) => m.level))
  const need = fleeTarget(maxLevel)
  const r = heroRoll(hero) + consumePrayer(hero)
  const log: LogEntry[] = []
  if (r >= need) {
    state.escaped.push(hero.uid)
    log.push(entry(`${hero.name} бежит: к18 = ${r} ≥ ${need} — удалось скрыться.`, 'flee'))
  } else {
    log.push(entry(`${hero.name} пытается бежать: к18 = ${r} < ${need} — не вышло, ход потерян.`, 'flee'))
  }
  log.push(...markActed(state, hero, heroes, idx))
  return log
}

export function heroSkip(state: CombatState, hero: Hero, heroes: Hero[], idx: DataIndex): LogEntry[] {
  return [entry(`${hero.name} пропускает ход.`), ...markActed(state, hero, heroes, idx)]
}

/**
 * Отмечает действие героя (с учётом дополнительных действий). Когда все активные герои сходили:
 * на дистанции — переход в ближний бой с броском инициативы, в ближнем бою — ход монстров.
 */
export function markActed(state: CombatState, hero: Hero, heroes: Hero[], idx: DataIndex): LogEntry[] {
  checkEnd(state, heroes)
  if (state.finished) return []
  // дополнительное действие — только если герой ещё на поле и может действовать
  if ((state.extraActions[hero.uid] ?? 0) > 0 && !state.escaped.includes(hero.uid) && isActive(hero)) {
    state.extraActions[hero.uid] -= 1
    return [entry(`${hero.name} может действовать ещё раз.`)]
  }
  if (!state.acted.includes(hero.uid)) state.acted.push(hero.uid)
  return advanceIfDone(state, heroes, idx)
}

/** Чары очаровавшего монстра спадают, как только он погиб или бежал */
function releaseCharms(state: CombatState, heroes: Hero[]): LogEntry[] {
  const log: LogEntry[] = []
  for (const h of heroes) {
    if (!h.status.charmed || aliveMonsters(state).some((x) => x.uid === h.status.charmed)) continue
    delete h.status.charmed
    if (isConscious(h)) log.push(entry(`Чары рассеиваются — ${h.name} снова в бою.`))
  }
  return log
}

/** Если все способные действовать герои сходили — переход в ближний бой или ход монстров */
export function advanceIfDone(state: CombatState, heroes: Hero[], idx: DataIndex): LogEntry[] {
  checkEnd(state, heroes)
  if (state.finished || state.turn !== 'heroes') return []
  // заклинатель пал от руки героя — очарованный ещё может сходить в этом раунде
  const freed = releaseCharms(state, heroes)
  const pending = activeHeroes(heroes, state).filter((h) => !state.acted.includes(h.uid))
  if (pending.length > 0) return freed
  if (state.phase === 'ranged') return [...freed, closeToMelee(state, heroes, idx)]
  state.turn = 'monsters'
  return freed
}

/** Принудительно закончить ход героев (запасной выход, если кто-то не может или не хочет действовать) */
export function endHeroesTurn(state: CombatState, heroes: Hero[], idx: DataIndex): LogEntry[] {
  if (state.finished || state.turn !== 'heroes') return []
  for (const h of heroes) if (!state.acted.includes(h.uid)) state.acted.push(h.uid)
  state.extraActions = {}
  return [entry('Герои заканчивают ход.'), ...advanceIfDone(state, heroes, idx)]
}

/** Завершить фазу дистанции и перейти к ближнему бою (бросок инициативы) */
export function closeToMelee(state: CombatState, heroes: Hero[], idx?: DataIndex): LogEntry {
  state.phase = 'melee'
  state.acted = []
  if (idx) grantRoundActions(state, heroes, idx)
  return rollInitiative(state, heroes, idx)
}

export function checkEnd(state: CombatState, heroes: Hero[]): void {
  if (state.finished) return
  if (aliveMonsters(state).length === 0) {
    state.finished = 'victory'
    state.loot = collectLoot(state.monsters)
    return
  }
  const fighters = heroes.filter((h) => !state.escaped.includes(h.uid))
  if (fighters.length === 0) state.finished = 'fled'
  else if (fighters.every((h) => !isConscious(h))) state.finished = 'defeat'
}

/** Герои, которых монстр может выбрать целью (невидимость, хрустальный щит, отворот мертвецов) */
function targetableHeroes(state: CombatState, heroes: Hero[], m: MonsterInstance): Hero[] {
  return fightingHeroes(heroes, state).filter((h) => {
    if (hasWard(h, 'invisible')) return false
    if (hasWard(h, 'crystal') && m.level <= 2) return false
    if (hasWard(h, 'undead') && UNDEAD.has(m.monsterId)) return false
    return true
  })
}

function monsterTargets(state: CombatState, heroes: Hero[], m: MonsterInstance): (Hero | AllyInstance)[] {
  return [...targetableHeroes(state, heroes, m), ...aliveAllies(state)]
}

/** Опыт за урон со временем (яд, удушье, окаменение, паралич) тому, кто его наложил */
function dotXp(state: CombatState, heroes: Hero[], m: MonsterInstance, kind: keyof NonNullable<MonsterInstance['dotBy']>, dealt: number, idx: DataIndex, log: LogEntry[]): void {
  const owner = m.dotBy?.[kind] ? heroes.find((h) => h.uid === m.dotBy![kind]) : undefined
  if (!owner || dealt <= 0) return
  const r = awardXp(state, owner, dealt, m, idx)
  if (r.xp) log.push(entry(`${owner.name} получает ${r.xp} очков опыта.`, 'xp'))
  for (const up of r.levelUps) log.push(entry(`${owner.name} достигает ${up.level} уровня!`, 'xp'))
}

/** Ход союзников (призванные существа): каждый атакует случайного монстра */
export function alliesTurn(state: CombatState, idx?: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  for (const a of aliveAllies(state)) {
    if (a.decoy || a.attacks === 'none') continue
    if (a.unstable && k6() === 1) {
      log.push(...loseControl(state, a, idx))
      if (a.dead) continue
    }
    const targets = aliveMonsters(state)
    if (!targets.length) break
    const t = targets[roll(targets.length) - 1]
    const need = t.defense + t.defenseMod
    const r = k18()
    if (r < need && !((t.disabled ?? 0) > 0 || t.petrified)) {
      log.push(entry(`${a.name} атакует ${t.name}: к18 = ${r} против защиты ${need} — промах.`, 'miss'))
      continue
    }
    let dmg: number
    // удача жертвы против атаки союзника («Огненная ящерица»: выкинула удачу — урон по запасной формуле)
    const saved = a.saveLuck !== undefined && !t.noSave && monsterRoll(t) >= a.saveLuck
    if (saved) log.push(entry(`${t.name} выкидывает удачу ${a.saveLuck} — ${a.name} обжигает слабее (${a.saveAttacks}).`, 'luck'))
    const formula = saved && a.saveAttacks ? a.saveAttacks : a.attacks
    if (/^\d+(-\d+)+$/.test(formula)) dmg = rollAttackTable(formula.split('-').map(Number)).damage
    else dmg = rollFormula(formula).total
    dmg = Math.floor(dmg * a.attackMultiplier)
    const d = damageMonster(t, dmg)
    log.push(entry(`${a.name} атакует ${t.name}: к18 = ${r} ≥ ${need} — ${t.name} теряет ${d.dealt} жизней.${d.killed ? ` ${t.name} повержен!` : ''}`, d.killed ? 'death' : 'damage'))
  }
  return log
}

/**
 * Выход из-под контроля (стр. 35): зомби — к3: 1 уходит, 2 нападает, 3 рассыпается в прах;
 * очарованный монстр — к6: 1–3 убегает, 4–6 нападает.
 */
export function loseControl(state: CombatState, a: AllyInstance, idx?: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  const turnHostile = () => {
    a.dead = true
    const base = a.monsterId && idx ? idx.monsterById.get(a.monsterId) : undefined
    if (!base) return
    const inst = makeMonsterInstance(base, 0)
    inst.name = a.name.replace(/\s*\(.*\)$/, '')
    inst.lives = Math.max(1, a.lives)
    inst.points = 0
    state.monsters.push(inst)
  }
  if (a.unstable === 'zombie') {
    const r = roll(3)
    if (r === 1) { a.dead = true; log.push(entry(`${a.name} выходит из-под контроля и уходит прочь.`, 'flee')) }
    else if (r === 2) { turnHostile(); log.push(entry(`${a.name} выходит из-под контроля и нападает на героев!`, 'death')) }
    else { a.dead = true; log.push(entry(`${a.name} рассыпается в прах.`)) }
  } else if (a.unstable === 'charm') {
    const r = k6()
    if (r <= 3) { a.dead = true; log.push(entry(`${a.name} сбрасывает чары и убегает.`, 'flee')) }
    else { turnHostile(); log.push(entry(`${a.name} сбрасывает чары и снова нападает!`, 'death')) }
  }
  return log
}

/** Ход монстров: союзники героев, статусы, храбрость, магия, атаки. Затем новый раунд. */
export function monstersTurn(state: CombatState, heroes: Hero[], idx: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  if (state.finished) return log
  log.push(...alliesTurn(state, idx))
  checkEnd(state, heroes)
  if (state.finished) return log
  for (const m of aliveMonsters(state)) {
    // щиты от заклинаний истекают
    if (m.wards?.length) {
      for (const w of m.wards) if (w.rounds > 0) w.rounds -= 1
      const gone = m.wards.filter((w) => w.rounds === 0)
      m.wards = m.wards.filter((w) => w.rounds !== 0)
      for (const w of gone) log.push(entry(`${w.source} у ${m.name} гаснет.`, 'spell'))
    }
    // статусы монстра
    if (m.poison && m.poison > 0) {
      const r = damageMonster(m, rollFormula('1к6').total)
      m.poison -= 1
      log.push(entry(`${m.name} страдает от яда: −${r.dealt} жизней.${r.killed ? ` ${m.name} погибает.` : ''}`, r.killed ? 'death' : 'damage'))
      dotXp(state, heroes, m, 'poison', r.dealt, idx, log)
      if (r.killed) continue
    }
    if (m.quake && m.quake > 0) {
      const r = damageMonster(m, rollFormula('1к18').total)
      m.quake -= 1
      log.push(entry(`Землетрясение: ${m.name} теряет ${r.dealt} жизней.${r.killed ? ` ${m.name} погибает.` : m.quake === 0 ? ' Земля успокаивается.' : ''}`, r.killed ? 'death' : 'damage'))
      dotXp(state, heroes, m, 'quake', r.dealt, idx, log)
      if (r.killed) continue
    }
    if (m.choke && m.choke > 0) {
      const r = damageMonster(m, rollFormula('1к3').total)
      m.choke -= 1
      if (m.choke === 0) { m.defenseMod += 4; m.attackMultiplier *= 2 }
      log.push(entry(`${m.name} задыхается: −${r.dealt} жизней.${r.killed ? ` ${m.name} погибает.` : m.choke === 0 ? ' Воздух возвращается.' : ''}`, r.killed ? 'death' : 'damage'))
      dotXp(state, heroes, m, 'choke', r.dealt, idx, log)
      if (r.killed) continue
    }
    if (m.petrified) {
      const r = damageMonster(m, rollFormula('1к6').total)
      log.push(entry(`${m.name} окаменел и теряет ${r.dealt} жизней.${r.killed ? ' Рассыпается в прах.' : ''}`, r.killed ? 'death' : 'damage'))
      dotXp(state, heroes, m, 'petrify', r.dealt, idx, log)
      continue
    }
    if (m.disabled && m.disabled > 0) {
      m.disabled -= 1
      if (m.disabledKind === 'paralysis') {
        const r = damageMonster(m, rollFormula('1к3').total)
        log.push(entry(`${m.name} парализован: −${r.dealt} жизней${m.disabled ? `, ещё ${m.disabled} раунд(ов)` : ''}.${r.killed ? ` ${m.name} погибает.` : ''}`, r.killed ? 'death' : 'damage'))
        dotXp(state, heroes, m, 'paralysis', r.dealt, idx, log)
      } else {
        log.push(entry(`${m.name} ${m.disabledKind === 'sleep' ? 'спит' : m.disabledKind === 'freeze' ? 'вмёрз в лёд' : m.disabledKind === 'charm' ? 'заворожён' : 'не может действовать'}${m.disabled ? ` (ещё ${m.disabled} раунд(ов))` : ' — приходит в себя'}.`))
      }
      continue
    }
    if (m.attacks === 'none' && !(m.spells?.length && (m.mana ?? 0) > 0)) {
      log.push(entry(`${m.name} не атакует.`))
      continue
    }
    // храбрость: при потере половины жизней один раз бросает к18 ≥ храбрость — бежит
    if (m.courage !== null && !m.courageChecked && m.lives * 2 <= m.maxLives) {
      m.courageChecked = true
      const r = monsterRoll(m)
      if (r >= m.courage) {
        m.fled = true
        log.push(entry(`${m.name} проверяет храбрость: ${r} ≥ ${m.courage} — обращается в бегство!`, 'flee'))
        continue
      }
      log.push(entry(`${m.name} проверяет храбрость: ${r} < ${m.courage} — с яростным криком бросается в атаку.`, 'flee'))
    }
    const targets = monsterTargets(state, heroes, m)
    if (!targets.length) {
      log.push(entry(`${m.name} не находит цели.`))
      continue
    }
    // ХАУСРУЛ: монстр с заклинаниями и маной колдует с вероятностью 1/2 (или всегда, если бьёт только магией)
    const spellLog = monsterCast(state, m, heroes, idx)
    if (spellLog) { log.push(...spellLog); checkEnd(state, heroes); if (state.finished) break; continue }
    if (m.attacks === 'magic' || m.attacks === 'none') { log.push(entry(`${m.name} выжидает.`)); continue }
    const target = targets[roll(targets.length) - 1]
    if ('ownerUid' in target) log.push(...monsterAttackAlly(m, target))
    else log.push(...monsterAttack(m, target, idx))
    checkEnd(state, heroes)
    if (state.finished) break
  }
  checkEnd(state, heroes)
  if (state.finished) return log
  log.push(...regrowHeads(state))
  // новый раунд
  state.round += 1
  state.turn = 'heroes'
  state.acted = []
  grantRoundActions(state, heroes, idx)
  for (const h of heroes) {
    h.buffs = h.buffs.filter((b) => b.rounds === -1 || --b.rounds > 0)
    log.push(...tickHeroStatus(h))
  }
  log.push(...releaseCharms(state, heroes))
  for (const h of heroes) {
    const caster = h.status.charmed && isConscious(h) ? aliveMonsters(state).find((x) => x.uid === h.status.charmed) : undefined
    if (caster && k6() === 1) { delete h.status.charmed; log.push(entry(`${h.name} стряхивает чары ${caster.name} (к6 = 1).`)) }
  }
  for (const a of state.allies) {
    if (!a.dead && a.rounds > 0 && --a.rounds === 0) { a.dead = true; log.push(entry(`${a.name} исчезает.`)) }
  }
  checkEnd(state, heroes)
  if (!state.finished && activeHeroes(heroes, state).length === 0 && fightingHeroes(heroes, state).length > 0) {
    log.push(entry('Никто из героев не может действовать — ход снова переходит к монстрам.'))
    state.turn = 'monsters'
  }
  log.push(entry(`— Раунд ${state.round} —`))
  return log
}

function normName(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/g, '').trim()
}

/** Какие заклинания монстр умеет применить: по героям (урон, контроль, ослабление, очарование, несчастье), на себя
 *  (усиления, щиты), лечение своих и призыв элементаля. «Инициативу» монстр произносит, когда стороны сходятся. */
const MONSTER_CONTROL = ['sleep', 'paralysis', 'petrify', 'freeze', 'web', 'hold', 'choke', 'charm', 'curse']
type MonsterSpellUse = 'attack' | 'self' | 'heal' | 'summon'
function monsterSpellUse(s: Spell): MonsterSpellUse | null {
  const e = s.effect
  if (e.type === 'damage') return 'attack'
  if (e.type === 'control') return MONSTER_CONTROL.includes(e.kind) ? 'attack' : null
  if (e.type === 'debuff') return e.scope === 'one' ? 'attack' : null
  if (e.type === 'heal') return 'heal'
  if (e.type === 'summon') return e.kind === 'elemental' ? 'summon' : null
  if (e.type === 'buff') return e.stat === 'dexterity' || e.stat === 'attacks' ? 'self' : null
  if (e.type === 'ward') return e.kind === 'antimagic' || e.kind === 'reflect' || e.kind === 'prayer' ? 'self' : null
  if (e.type === 'weapon') return 'self'
  return null
}
function monsterSpellOptions(m: MonsterInstance, idx: DataIndex): Spell[] {
  if (!m.spells?.length || !(m.mana ?? 0)) return []
  const byName = new Map<string, Spell>()
  for (const s of idx.data.spells) if (!byName.has(normName(s.name))) byName.set(normName(s.name), s)
  const out: Spell[] = []
  for (const n of m.spells) {
    const s = byName.get(normName(n))
    if (!s || !monsterSpellUse(s)) continue
    const cost = s.effect.type === 'heal' ? 1 : typeof s.cost === 'number' ? s.cost : m.level
    if (cost <= (m.mana ?? 0)) out.push(s)
  }
  return out
}

/** Герои, на которых заклинание монстра подействует: по пределу уровня, без повторного очарования и несчастья.
 *  ХАУСРУЛ: монстр не тратит ману на заведомо бесполезное заклинание. */
function spellEligible(spell: Spell, heroes: Hero[]): Hero[] {
  const e = spell.effect
  if (e.type !== 'control') return heroes
  const already = (h: Hero) => (e.kind === 'charm' && !!h.status.charmed) || (e.kind === 'curse' && !!h.status.cursed)
    || (e.kind === 'choke' && !!h.status.choke) || (e.kind === 'hold' && h.buffs.some((b) => b.source === spell.name))
  return heroes.filter((h) => (e.maxLevel === undefined || h.level <= e.maxLevel) && !already(h))
}

/** Выбор заклинания по обстановке: раненый союзник — лечение, неналоженное усиление — иногда, иначе атака */
function pickMonsterSpell(state: CombatState, m: MonsterInstance, options: Spell[], candidates: Hero[]): Spell | null {
  const wounded = aliveMonsters(state).some((x) => x.lives * 2 < x.maxLives)
  const heal = options.find((s) => monsterSpellUse(s) === 'heal')
  if (heal && wounded) return heal
  const fresh = options.filter((s) => { const u = monsterSpellUse(s); return (u === 'self' || u === 'summon') && !(m.buffed ?? []).includes(s.id) })
  const attack = options.filter((s) => monsterSpellUse(s) === 'attack' && spellEligible(s, candidates).length > 0)
  if (fresh.length && (!attack.length || k6() <= 3)) return fresh[roll(fresh.length) - 1]
  return attack.length ? attack[roll(attack.length) - 1] : null
}

/** Элементал, призванный монстром: к6 (1–4) — воздушный, водный, земной, огненный; таблица атак по силе (ХАУСРУЛ) */
function summonMonsterElemental(state: CombatState, m: MonsterInstance): LogEntry {
  let r = k6()
  while (r > 4) r = k6()
  const kinds = [
    { name: 'Воздушный элементал', defense: 12, attacks: [1, 2, 3, 4, 5, 6], lives: 10 },
    { name: 'Водный элементал', defense: 13, attacks: [3, 5, 6, 7, 9, 11], lives: 15 },
    { name: 'Земной элементал', defense: 14, attacks: [6, 8, 10, 11, 13, 15], lives: 20 },
    { name: 'Огненный элементал', defense: 15, attacks: [9, 12, 13, 15, 16, 19], lives: 25 },
  ]
  const k = kinds[r - 1]
  state.monsters.push({
    uid: uid('mon'), monsterId: 'elemental', name: k.name, level: r + 2, lives: k.lives, maxLives: k.lives, defense: k.defense,
    attacks: k.attacks, courage: null, points: 5 * r, courageChecked: true, fled: false, dead: false,
    defenseMod: 0, attackMod: 0, attackMultiplier: 1, summoned: true,
  })
  return entry(`к6 = ${r}: ${m.name} призывает — является ${k.name} (защита ${k.defense}, жизни ${k.lives}).`, 'spell')
}

/** Заклинание монстра на себя или своих: усиление, щит, лечение, призыв */
function monsterSelfCast(state: CombatState, m: MonsterInstance, spell: Spell, log: LogEntry[]): void {
  const e = spell.effect
  m.buffed = [...(m.buffed ?? []), spell.id]
  if (e.type === 'heal') {
    const target = [...aliveMonsters(state)].sort((a, b) => a.lives / a.maxLives - b.lives / b.maxLives)[0]
    const amount = Math.min(Math.max(0, (m.mana ?? 0) + 1), target.maxLives - target.lives)
    m.mana = (m.mana ?? 0) + 1 - amount // стоимость 1 уже списана при выборе
    target.lives += amount
    log.push(entry(`${target.name} восстанавливает ${amount} жизней (${target.lives}/${target.maxLives}).`, 'spell'))
  } else if (e.type === 'summon') {
    log.push(summonMonsterElemental(state, m))
  } else if (e.type === 'buff') {
    if (e.stat === 'dexterity') { m.hitMod = (m.hitMod ?? 0) + Number(e.amount); log.push(entry(`${m.name}: попадание +${e.amount} до конца боя.`, 'spell')) }
    else { m.attackMod += Number(e.amount); log.push(entry(`${m.name}: атаки +${e.amount} до конца боя.`, 'spell')) }
  } else if (e.type === 'weapon') {
    // ХАУСРУЛ: «Огненный меч» у монстра — атаки +4 и попадание +ловкость меча до конца боя
    m.attackMod += 4
    m.hitMod = (m.hitMod ?? 0) + (e.dexterityBonus ?? 0)
    log.push(entry(`В руках ${m.name} вспыхивает ${e.name}: атаки +4${e.dexterityBonus ? `, попадание +${e.dexterityBonus}` : ''}.`, 'spell'))
  } else if (e.type === 'ward') {
    if (e.kind === 'prayer') { m.prayer = 3; log.push(entry(`${m.name} молится: +3 к следующему броску.`, 'spell')) }
    else if (e.kind === 'antimagic') {
      const rounds = Math.max(1, Math.ceil(m.level / 2))
      m.wards = [...(m.wards ?? []), { kind: 'antimagic', level: spell.level, rounds, source: spell.name }]
      log.push(entry(`${m.name} окружает себя огненным щитом: заклинания героев не действуют на него ${rounds} раунд(ов).`, 'spell'))
    } else {
      m.wards = [...(m.wards ?? []), { kind: 'reflect', level: m.level, rounds: -1, source: spell.name }]
      log.push(entry(`${m.name} готов отразить заклинание до ${m.level} уровня.`, 'spell'))
    }
  }
}

export function monsterCast(state: CombatState, m: MonsterInstance, heroes: Hero[], idx: DataIndex): LogEntry[] | null {
  const options = monsterSpellOptions(m, idx)
  if (!options.length) return null
  const always = m.attacks === 'magic' || m.attacks === 'none'
  if (!always && k6() > 3) return null
  const spell = pickMonsterSpell(state, m, options, targetableHeroes(state, heroes, m))
  if (!spell) return null
  const cost = spell.effect.type === 'heal' ? 1 : typeof spell.cost === 'number' ? spell.cost : m.level
  m.mana = (m.mana ?? 0) - cost
  const log: LogEntry[] = [entry(`${m.name} произносит «${spell.name}».`, 'spell')]
  const use = monsterSpellUse(spell)
  if (use !== 'attack') { monsterSelfCast(state, m, spell, log); return log }
  const candidates = targetableHeroes(state, heroes, m)
  if (!candidates.length) return [...log, entry('Заклинание уходит в пустоту — цели не видно.')]
  const effect = spell.effect
  // по всем — урон по площади, «Паутина» и «Удушье»; одиночное — по случайному герою, на которого оно подействует
  const pool = spellEligible(spell, candidates)
  const single = pool.length ? pool : candidates
  const area = effect.type === 'damage' ? effect.targets !== 'one' : effect.type === 'control' && effect.targets === 'all'
  const targets = area ? pool : [single[roll(single.length) - 1]]
  for (const target of targets) {
    // Отражение магии: заклинание уровня не выше мага возвращается к монстру
    const mirror = hasWard(target, 'reflect')
    if (mirror && spell.level <= mirror.amount) {
      target.buffs = target.buffs.filter((b) => b !== mirror)
      log.push(entry(`${target.name} отражает «${spell.name}» — заклинание бьёт по ${m.name}.`, 'spell'))
      if (effect.type === 'damage') {
        const dmg = rollSpellDamage(effect, m.level, m.lives)
        const d = damageMonster(m, dmg.total)
        log.push(entry(`${m.name} теряет ${d.dealt} жизней (${dmg.detail}).${d.killed ? ` ${m.name} повержен!` : ''}`, d.killed ? 'death' : 'damage'))
        const xp = awardXp(state, target, d.dealt, m, idx)
        if (xp.xp) log.push(entry(`${target.name} получает ${xp.xp} очков опыта.`, 'xp'))
      } else if (effect.type === 'control') {
        // отражённое заклинание действует на монстра так же, как на героя: с пределом уровня и своей длительностью
        if (effect.maxLevel !== undefined && m.level > effect.maxLevel) log.push(entry(`${m.name} слишком силён для собственного заклинания — оно рассеивается.`, 'spell'))
        else if (effect.kind === 'curse') m.cursed = true
        else if (effect.kind === 'charm') { m.disabled = k6(); m.disabledKind = 'charm' }
        else if (effect.kind === 'petrify') m.petrified = true
        else if (effect.kind === 'web') { m.disabled = Math.max(m.disabled ?? 0, 1); m.disabledKind = 'freeze' }
        else if (effect.kind === 'hold') { if (!m.held) { m.held = true; m.defenseMod -= 2; m.attackMultiplier *= 0.5 } }
        else if (effect.kind === 'choke') {
          const rounds = Math.max(1, Math.ceil(m.level / 2))
          if (!m.choke) { m.defenseMod -= 4; m.attackMultiplier *= 0.5 }
          m.choke = Math.max(m.choke ?? 0, rounds)
        } else { m.disabled = k6(); m.disabledKind = effect.kind === 'paralysis' ? 'paralysis' : effect.kind === 'sleep' ? 'sleep' : 'freeze' }
        log.push(entry(`${m.name} попадает под собственное заклинание.`, 'spell'))
      } else if (effect.type === 'debuff') {
        m.attackMultiplier *= 0.5
        log.push(entry(`${m.name} слабеет от собственного заклинания: атаки вдвое.`, 'spell'))
      }
      if (m.dead) break
      continue
    }
    // Огненный щит защищает того, на кого наложен
    const fire = hasWard(target, 'antimagic')
    if (fire) {
      log.push(entry(`${fire.source} поглощает заклинание (${target.name}).`, 'spell'))
      continue
    }
    // Воздушный щит: общий запас уровней заклинаний; заклинание сильнее остатка проходит
    const air = hasWard(target, 'spell-shield')
    if (air && (air.charge ?? 0) >= spell.level) {
      spendPool(heroes, air, spell.level)
      log.push(entry(`${air.source} поглощает заклинание ${spell.level} уровня (${target.name}); запас ${Math.max(0, air.charge ?? 0)}.`, 'spell'))
      continue
    }
    if (hasWard(target, 'invulnerable')) {
      log.push(entry(`${target.name} неуязвим — заклинание не причиняет вреда.`, 'spell'))
      continue
    }
    if (spell.luck) {
      const r = heroRoll(target) + consumePrayer(target)
      const luck = heroLuck(target, idx)
      if (r + luck >= spell.luck) {
        log.push(entry(`${target.name} бросает удачу от заклинания: ${r}${luck ? ` + ${luck}` : ''} ≥ ${spell.luck} — увернулся.`, 'luck'))
        continue
      }
      log.push(entry(`${target.name} бросает удачу от заклинания: ${r}${luck ? ` + ${luck}` : ''} < ${spell.luck}.`, 'luck'))
    }
    if (effect.type === 'damage') {
      const dmg = rollSpellDamage(effect, m.level, target.lives)
      const lost = -changeLives(target, -dmg.total)
      log.push(entry(`${target.name} теряет ${lost} жизней (${dmg.detail}). У ${target.name} ${target.lives}/${target.maxLives}.`, 'damage'))
      if (target.status.dead) log.push(entry(`${target.name} погибает.`, 'death'))
      else if (target.status.unconscious) log.push(entry(`${target.name} теряет сознание.`, 'death'))
    } else if (effect.type === 'control') {
      if (effect.maxLevel !== undefined && target.level > effect.maxLevel) { log.push(entry(`${target.name} слишком силён для «${spell.name}».`)); continue }
      const kind = effect.kind === 'sleep' ? 'freeze' : effect.kind
      if (kind === 'freeze' || kind === 'paralysis' || kind === 'petrify') applyExtraAttack(target, kind, log, effect.kind === 'sleep')
      else if (kind === 'web') {
        target.status.freeze = Math.max(target.status.freeze ?? 0, 1)
        markFresh(target, 'freeze')
        log.push(entry(`${target.name} опутан паутиной и пропускает раунд.`, 'damage'))
      } else if (kind === 'hold') {
        // повторная «Рука» не складывается с уже схватившей
        if (!target.buffs.some((b) => b.source === spell.name)) target.buffs.push({ source: spell.name, stat: 'defense', amount: -2, rounds: -1 }, { source: spell.name, stat: 'attacks', amount: 0.5, multiplier: true, rounds: -1 })
        log.push(entry(`${target.name} схвачен магической рукой: защита −2, атаки вдвое слабее до конца боя.`, 'damage'))
      } else if (kind === 'choke') {
        const rounds = Math.max(1, Math.ceil(m.level / 2))
        target.status.choke = Math.max(target.status.choke ?? 0, rounds)
        // повторное «Удушье» продлевает действие, а не складывает защиту −4 и атаки вдвое
        const held = target.buffs.filter((b) => b.source === spell.name)
        if (held.length) for (const b of held) b.rounds = Math.max(b.rounds, rounds)
        else target.buffs.push({ source: spell.name, stat: 'defense', amount: -4, rounds }, { source: spell.name, stat: 'attacks', amount: 0.5, multiplier: true, rounds })
        log.push(entry(`${target.name} задыхается: защита −4, атаки вдвое, −1к3 жизней за раунд (${rounds} раунд(ов)).`, 'damage'))
      } else if (kind === 'charm') {
        // ХАУСРУЛ: очарованный герой не действует; каждый раунд к6 = 1 — приходит в себя (вероятность 1/6 из описания),
        // чары спадают от удара, отнявшего жизни, если заклинатель погиб или бежал, и после боя
        target.status.charmed = m.uid
        log.push(entry(`${target.name} очарован и стоит, не поднимая оружия. Чары спадут от удара, со смертью ${m.name} или сами (1 на к6 каждый раунд).`, 'damage'))
      } else if (kind === 'curse') {
        target.status.cursed = true
        log.push(entry(`${target.name} проклят неудачей: до конца боя бросает кубики дважды и берёт меньшее.`, 'damage'))
      }
    } else if (effect.type === 'debuff') {
      // «Слабость» по герою: атаки вдвое слабее до конца боя
      target.buffs.push({ source: spell.name, stat: 'attacks', amount: 0.5, multiplier: true, rounds: -1 })
      log.push(entry(`${target.name} слабеет: атаки вдвое до конца боя.`, 'damage'))
    }
  }
  return log
}

function spendPool(heroes: Hero[], ward: Buff, amount: number): void {
  const buffs = heroes.flatMap((h) => h.buffs.filter((b) => b === ward || (ward.poolId && b.poolId === ward.poolId)))
  for (const b of buffs) b.charge = (b.charge ?? 0) - amount
  if ((ward.charge ?? 0) <= 0) for (const h of heroes) h.buffs = h.buffs.filter((b) => !buffs.includes(b))
}

export function monsterAttackAlly(m: MonsterInstance, a: AllyInstance): LogEntry[] {
  const r = monsterHitRoll(m)
  if (r < a.defense) return [entry(`${m.name} атакует ${a.name}: к18 = ${r} против защиты ${a.defense} — промах.`, 'miss')]
  if (a.decoy) {
    a.dead = true
    return [entry(`${m.name} атакует ${a.name}: удар проходит сквозь иллюзию, и она рассеивается.`, 'hit')]
  }
  if (!Array.isArray(m.attacks)) {
    a.dead = true
    return [entry(`${m.name} поражает ${a.name} — существо уничтожено.`, 'death')]
  }
  const at = rollAttackTable(m.attacks)
  const dmg = Math.max(0, Math.floor((at.damage + m.attackMod) * m.attackMultiplier))
  a.lives -= dmg
  if (a.lives <= 0) a.dead = true
  return [entry(`${m.name} атакует ${a.name}: к18 = ${r} ≥ ${a.defense} — ${dmg} жизней.${a.dead ? ` ${a.name} уничтожен.` : ` Осталось ${a.lives}.`}`, a.dead ? 'death' : 'damage')]
}

/** Бросок героя к18: под «Несчастьем» монстра — дважды, берётся меньшее */
export function heroRoll(h: Hero): number {
  return h.status.cursed ? Math.min(k18(), k18()) : k18()
}

/** Бросок монстра: при «Несчастье» — дважды, берётся меньшее */
function monsterRoll(m: MonsterInstance): number {
  return m.cursed ? Math.min(k18(), k18()) : k18()
}
/** Бросок попадания монстра: с бонусами «Ловкости», «Огненного меча» и разовой «Молитвой» */
function monsterHitRoll(m: MonsterInstance): number {
  let r = monsterRoll(m) + (m.hitMod ?? 0)
  if (m.prayer) { r += m.prayer; m.prayer = 0 }
  return r
}

/** Монстры, которые по Бестиарию бьют из лука или метательным оружием (ХАУСРУЛ: от них защищает «Воздушная стена»;
 *  Амазонка не в списке — она «не менее мастерски» владеет мечом) */
const ARCHERS = new Set(['hazg', 'kentavr', 'gnom'])

export function monsterAttack(m: MonsterInstance, target: Hero, idx: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  if (ARCHERS.has(m.monsterId) && hasWard(target, 'air-wall')) {
    log.push(entry(`${m.name} стреляет в ${target.name}, но стрела отскакивает от воздушной стены.`, 'miss'))
    return log
  }
  const def = heroDefense(target, idx)
  const r = monsterHitRoll(m)
  if (r < def) {
    log.push(entry(`${m.name} атакует ${target.name}: к18 = ${r} против защиты ${def} — промах.`, 'miss'))
    return log
  }
  if (hasWard(target, 'invulnerable')) {
    log.push(entry(`${m.name} атакует ${target.name}: попадание, но ${target.name} неуязвим — вреда нет.`, 'hit'))
    return log
  }
  const monster = idx.monsterById.get(m.monsterId)
  if (m.attacks === 'death') {
    if (!monster?.luckSave) {
      // ХАУСРУЛ 8: если удача от атаки не указана — спасброска нет
      target.lives = -10
      changeLives(target, 0)
      log.push(entry(`${m.name} поражает ${target.name} — ${target.name} погибает.`, 'death'))
      return log
    }
    const need = monster.luckSave.threshold
    const lr = heroRoll(target) + consumePrayer(target)
    const luck = heroLuck(target, idx)
    if (lr + luck >= need) {
      log.push(entry(`${m.name} поражает ${target.name} (${monster?.luckSave?.against ?? 'смертельная атака'})! Бросок удачи ${lr}+${luck} ≥ ${need} — ${target.name} уцелел.`, 'luck'))
    } else {
      target.lives = -10
      changeLives(target, 0)
      log.push(entry(`${m.name} поражает ${target.name}! Бросок удачи ${lr}+${luck} < ${need} — ${target.name} погибает.`, 'death'))
    }
    return log
  }
  if (!Array.isArray(m.attacks)) return log
  // дополнительная атака (яд, паралич, окаменение, оледенение) вместо обычного удара; если их несколько —
  // по очереди, срабатывает первая, чей бросок прошёл
  for (const ex of m.extraAttacks ?? []) {
    const er = k18()
    if (er >= ex.threshold) {
      const rule = EXTRA_ATTACKS[ex.kind]
      const shield = hasWard(target, 'spell-shield')
      if (shield) {
        log.push(entry(`${m.name} применяет «${rule.name}», но ${shield.source} отражает её.`, 'spell'))
        return log
      }
      const lr = heroRoll(target) + consumePrayer(target)
      const luck = heroLuck(target, idx)
      if (lr + luck >= rule.luck) {
        log.push(entry(`${m.name} применяет «${rule.name}» (к18 = ${er} ≥ ${ex.threshold}), но ${target.name} бросает удачу ${lr}+${luck} ≥ ${rule.luck} и избегает её.`, 'luck'))
        return log
      }
      log.push(entry(`${m.name} применяет «${rule.name}» (к18 = ${er} ≥ ${ex.threshold}); бросок удачи ${lr}+${luck} < ${rule.luck}.`, 'hit'))
      applyExtraAttack(target, ex.kind, log)
      return log
    }
  }
  let a = rollAttackTable(m.attacks)
  if (m.cursed) { const b = rollAttackTable(m.attacks); if (b.damage < a.damage) a = b }
  const dmg = Math.max(0, Math.floor((a.damage + m.attackMod) * m.attackMultiplier))
  const delta = changeLives(target, -dmg)
  log.push(entry(`${m.name} атакует ${target.name}: к18 = ${r} ≥ ${def} — попадание, к6 = ${a.roll} → ${-delta} жизней. У ${target.name} ${target.lives}/${target.maxLives}.`, 'damage'))
  if (target.status.charmed && delta < 0 && isConscious(target)) {
    delete target.status.charmed
    log.push(entry(`Боль приводит ${target.name} в чувство — чары спадают.`))
  }
  if (target.status.dead) log.push(entry(`${target.name} погибает.`, 'death'))
  else if (target.status.unconscious) log.push(entry(`${target.name} теряет сознание.`, 'death'))
  return log
}

export function applyExtraAttack(target: Hero, kind: keyof typeof EXTRA_ATTACKS, log: LogEntry[], sleep = false): void {
  switch (kind) {
    case 'freeze': {
      const rounds = k6()
      if (sleep) {
        target.status.freeze = rounds
        markFresh(target, 'freeze')
        log.push(entry(`${target.name} засыпает на ${rounds} раунд(ов).`, 'damage'))
        break
      }
      const d = rollFormula('1к18')
      const lost = -limitedLoss(target, d.total)
      target.status.freeze = rounds
      markFresh(target, 'freeze')
      log.push(entry(`${target.name} превращается в глыбу льда: −${lost} жизней, обездвижен на ${rounds} раунд(ов).`, 'damage'))
      break
    }
    case 'petrify':
      target.status.petrified = true
      log.push(entry(`${target.name} окаменел до конца боя и будет терять 1к6 жизней за раунд.`, 'damage'))
      break
    case 'paralysis': {
      const rounds = k6()
      target.status.paralysis = rounds
      markFresh(target, 'paralysis')
      log.push(entry(`${target.name} парализован на ${rounds} раунд(ов), теряет 1к3 жизней за раунд.`, 'damage'))
      break
    }
    case 'poison': {
      const d = rollFormula('1к6')
      const lost = -limitedLoss(target, d.total)
      target.status.poison = -1
      log.push(entry(`${target.name} отравлен: −${lost} жизней и по 1 жизни за раунд до противоядия.`, 'damage'))
      break
    }
  }
}

/** Яд, паралич, оледенение и окаменение не отнимают больше жизней, чем есть (до 0) */
function limitedLoss(hero: Hero, amount: number): number {
  const loss = Math.min(amount, Math.max(0, hero.lives))
  return changeLives(hero, -loss)
}

function markFresh(h: Hero, kind: 'paralysis' | 'freeze'): void {
  h.status.fresh = [...(h.status.fresh ?? []).filter((k) => k !== kind), kind]
}

/** Статус, наложенный в этот ход монстров, начинает отсчёт со следующего раунда */
function consumeFresh(h: Hero, kind: 'paralysis' | 'freeze'): boolean {
  if (!h.status.fresh?.includes(kind)) return false
  h.status.fresh = h.status.fresh.filter((k) => k !== kind)
  if (!h.status.fresh.length) delete h.status.fresh
  return true
}

export function tickHeroStatus(h: Hero): LogEntry[] {
  const log: LogEntry[] = []
  if (!isConscious(h)) return log
  if (h.status.paralysis && h.status.paralysis > 0 && !consumeFresh(h, 'paralysis')) {
    const d = rollFormula('1к3')
    const lost = -limitedLoss(h, d.total)
    h.status.paralysis -= 1
    log.push(entry(`${h.name} парализован: −${lost} жизней${h.status.paralysis ? `, ещё ${h.status.paralysis} раунд(ов)` : ', паралич проходит'}.`, 'damage'))
  }
  if (h.status.freeze && h.status.freeze > 0 && !consumeFresh(h, 'freeze')) {
    h.status.freeze -= 1
    if (h.status.freeze === 0) log.push(entry(`${h.name} приходит в себя.`))
  }
  if (h.status.petrified) {
    const d = rollFormula('1к6')
    const lost = -limitedLoss(h, d.total)
    log.push(entry(`${h.name} окаменел: −${lost} жизней.`, 'damage'))
  }
  if (h.status.choke && h.status.choke > 0) {
    const d = rollFormula('1к3')
    const lost = -limitedLoss(h, d.total)
    h.status.choke -= 1
    log.push(entry(`${h.name} задыхается: −${lost} жизней${h.status.choke ? `, ещё ${h.status.choke} раунд(ов)` : ', дыхание возвращается'}.`, 'damage'))
    if (!h.status.choke) delete h.status.choke
  }
  if (h.status.poison === -1 && h.lives > 0) {
    const lost = -limitedLoss(h, 1)
    log.push(entry(`${h.name} страдает от яда: −${lost} жизнь.`, 'damage'))
  }
  return log
}

/** Снять боевые статусы и баффы (кроме благословения «Удача») — после боя и при прерывании */
export function cleanupAfterCombat(heroes: Hero[]): void {
  for (const h of heroes) {
    h.buffs = h.buffs.filter((b) => b.stat === 'ward' && b.ward === 'luck')
    delete h.status.petrified
    delete h.status.freeze
    delete h.status.paralysis
    delete h.status.choke
    delete h.status.fresh
    delete h.status.cursed
    delete h.status.charmed
  }
}

/** Завершение боя: снять боевые статусы и баффы, после победы подобрать дротики, копья и попавшие стрелы */
export function finishCombat(state: CombatState, heroes: Hero[], idx?: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  if (state.finished === 'victory') {
    for (const h of heroes) {
      const bag = state.recover?.[h.uid]
      if (!bag || h.status.dead) continue
      const parts: string[] = []
      for (const [ref, n] of Object.entries(bag)) {
        if (n <= 0) continue
        addToInventory(h, 'weapon', ref, n)
        parts.push(`${idx?.weaponById.get(ref)?.name ?? ref}${n > 1 ? ` ×${n}` : ''}`)
      }
      if (parts.length) log.push(entry(`${h.name} подбирает: ${parts.join(', ')}.`))
    }
    const left = state.loot ?? []
    if (left.length && idx) log.push(entry(`На поле боя остались трофеи: ${left.map((it) => entryName({ uid: it.uid, kind: it.kind, ref: it.ref, qty: 1 }, idx)).join(', ')}.`))
  }
  cleanupAfterCombat(heroes)
  const total = Object.values(state.xpEarned).reduce((a, b) => a + b, 0)
  const verdict = state.finished === 'victory' ? 'Победа!' : state.finished === 'fled' ? 'Команда отступила.' : 'Поражение...'
  log.push(entry(`${verdict} Опыт за бой: ${total}.`, 'xp'))
  return log
}

/** Для сводки: порог следующего уровня */
export function xpToNext(hero: Hero, idx: DataIndex): number | null {
  const cls = idx.cls(hero.classId)
  if (hero.level >= 12) return null
  return levelRow(cls, hero.level + 1).xp - hero.xp
}
