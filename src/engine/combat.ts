/** Бой (стр. 17–19 Инструкции): раунды, инициатива, атаки, храбрость, доп. атаки, бегство, союзники, магия монстров. */
import type { Monster, Spell } from '@/types'
import type { DataIndex } from './data'
import type { AllyInstance, CombatState, EquipSlot, Hero, LogEntry, MonsterInstance } from './model'
import { uid } from './model'
import { changeLives, gainXp, hasWard, heroAccuracy, heroDefense, heroDexterity, heroLuck, heroStrength, heroWeapons, isActive, isConscious, levelRow, UNARMED, type HandWeapon, type LevelUp } from './character'
import { k18, k6, roll, rollAttackTable, rollFormula } from './dice'
import { EXTRA_ATTACKS, fleeTarget } from './rules'
import { rollSpellDamage } from './spells'

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
    spells: m.spells,
    courageChecked: false,
    fled: false,
    dead: false,
    defenseMod: 0,
    attackMod: 0,
    attackMultiplier: 1,
  }
}

export function makeAlly(ownerUid: string, name: string, defense: number, attacks: string, lives: number, rounds = -1, decoy = false): AllyInstance {
  return { uid: uid('ally'), ownerUid, name, defense, attacks, lives, maxLives: lives, rounds, decoy, attackMultiplier: 1 }
}

export function startCombat(specs: EncounterSpec[], idx: DataIndex, returnTo?: string): { state: CombatState; log: LogEntry[] } {
  const monsters: MonsterInstance[] = []
  for (const s of specs) {
    const m = idx.monster(s.monsterId)
    for (let i = 1; i <= s.count; i++) monsters.push(makeMonsterInstance(m, s.count > 1 ? i : 0))
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

/** Бросок инициативы перед ближним боем: к18 с каждой стороны, при равенстве перебрасывается.
 *  Вор 12 уровня «всегда атакует первым»; заклинание «Инициатива» даёт то же на один бой. */
export function rollInitiative(state: CombatState, heroes: Hero[], idx?: DataIndex): LogEntry {
  const auto = heroes.find((h) => !state.escaped.includes(h.uid) && isConscious(h) && (h.status.initiative || (h.level >= 12 && idx?.cls(h.classId).id === 'thief')))
  if (auto) {
    delete auto.status.initiative
    state.initiative = { heroes: 18, monsters: 0 }
    state.turn = 'heroes'
    return entry(`${auto.name} атакует первым — инициатива у героев.`)
  }
  let h = k18()
  let m = k18()
  while (h === m) {
    h = k18()
    m = k18()
  }
  state.initiative = { heroes: h, monsters: m }
  state.turn = h > m ? 'heroes' : 'monsters'
  return entry(`Инициатива: команда ${h}, монстры ${m} — первыми атакуют ${h > m ? 'герои' : 'монстры'}.`)
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
  if (state.phase === 'melee' && ranged && w?.entry?.kind === 'weapon' && !idx.weapon(w.entry.ref).throwable) {
    // ХАУСРУЛ: луки и арбалеты в ближнем бою не используются; дротики и копья — можно
    out.log.push(entry('Противник вплотную — из лука уже не выстрелить.'))
    return out
  }
  const name = w?.name ?? 'голые руки'
  const bonus = ranged ? heroAccuracy(hero, idx) + (w?.accuracyBonus ?? 0) : heroDexterity(hero) + (w?.dexterityBonus ?? 0)
  const need = target.defense + target.defenseMod
  const helpless = (target.disabled ?? 0) > 0 || target.petrified
  const swings = w?.attacksPerRound ?? 1
  for (let swing = 0; swing < swings; swing++) {
    const r = k18()
    // ХАУСРУЛ: по спящему, парализованному или окаменевшему противнику попадают автоматически
    const hit = w?.alwaysHits || helpless || r + bonus >= need
    out.log.push(entry(`${hero.name} атакует ${target.name} (${name}): к18 = ${r}${bonus ? ` + ${bonus}` : ''} против защиты ${need} — ${hit ? (helpless ? 'беззащитная цель, попадание' : 'попадание') : 'промах'}.`, hit ? 'hit' : 'miss'))
    if (!hit) continue
    out.hit = true
    let total = 0
    const parts: string[] = []
    const rollsCount = w?.doubleDamage ? 2 : 1
    for (let i = 0; i < rollsCount; i++) {
      if (w?.formula) {
        const f = rollFormula(w.formula)
        total += f.total
        parts.push(`${w.formula} = ${f.total}`)
      } else {
        const a = rollAttackTable(w?.attacks ?? UNARMED)
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

/** Попытка бегства: к18 против таблицы по уровню самого сильного монстра */
export function heroFlee(state: CombatState, hero: Hero, heroes: Hero[], idx: DataIndex): LogEntry[] {
  const maxLevel = Math.max(1, ...aliveMonsters(state).map((m) => m.level))
  const need = fleeTarget(maxLevel)
  const r = k18()
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
  if ((state.extraActions[hero.uid] ?? 0) > 0) {
    state.extraActions[hero.uid] -= 1
    checkEnd(state, heroes)
    return state.finished ? [] : [entry(`${hero.name} может действовать ещё раз.`)]
  }
  if (!state.acted.includes(hero.uid)) state.acted.push(hero.uid)
  checkEnd(state, heroes)
  if (state.finished) return []
  const pending = activeHeroes(heroes, state).filter((h) => !state.acted.includes(h.uid))
  if (pending.length > 0) return []
  if (state.phase === 'ranged') return [closeToMelee(state, heroes, idx)]
  state.turn = 'monsters'
  return []
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
    return
  }
  const fighters = heroes.filter((h) => !state.escaped.includes(h.uid))
  if (fighters.length === 0) state.finished = 'fled'
  else if (fighters.every((h) => !isConscious(h))) state.finished = 'defeat'
}

function monsterTargets(state: CombatState, heroes: Hero[], m: MonsterInstance): (Hero | AllyInstance)[] {
  const heroesOk = fightingHeroes(heroes, state).filter((h) => {
    if (hasWard(h, 'invisible')) return false
    if (hasWard(h, 'crystal') && m.level <= 2) return false
    if (hasWard(h, 'undead') && UNDEAD.has(m.monsterId)) return false
    return true
  })
  return [...heroesOk, ...aliveAllies(state)]
}

/** Ход союзников (призванные существа): каждый атакует случайного монстра */
export function alliesTurn(state: CombatState): LogEntry[] {
  const log: LogEntry[] = []
  for (const a of aliveAllies(state)) {
    if (a.decoy || a.attacks === 'none') continue
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
    if (/^\d+(-\d+)+$/.test(a.attacks)) dmg = rollAttackTable(a.attacks.split('-').map(Number)).damage
    else dmg = rollFormula(a.attacks).total
    dmg = Math.floor(dmg * a.attackMultiplier)
    const d = damageMonster(t, dmg)
    log.push(entry(`${a.name} атакует ${t.name}: к18 = ${r} ≥ ${need} — ${t.name} теряет ${d.dealt} жизней.${d.killed ? ` ${t.name} повержен!` : ''}`, d.killed ? 'death' : 'damage'))
  }
  return log
}

/** Ход монстров: союзники героев, статусы, храбрость, магия, атаки. Затем новый раунд. */
export function monstersTurn(state: CombatState, heroes: Hero[], idx: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  if (state.finished) return log
  log.push(...alliesTurn(state))
  checkEnd(state, heroes)
  if (state.finished) return log
  for (const m of aliveMonsters(state)) {
    // статусы монстра
    if (m.poison && m.poison > 0) {
      const r = damageMonster(m, rollFormula('1к6').total)
      m.poison -= 1
      log.push(entry(`${m.name} страдает от яда: −${r.dealt} жизней.${r.killed ? ` ${m.name} погибает.` : ''}`, r.killed ? 'death' : 'damage'))
      if (r.killed) continue
    }
    if (m.choke && m.choke > 0) {
      const r = damageMonster(m, rollFormula('1к3').total)
      m.choke -= 1
      if (m.choke === 0) { m.defenseMod += 4; m.attackMultiplier *= 2 }
      log.push(entry(`${m.name} задыхается: −${r.dealt} жизней.${r.killed ? ` ${m.name} погибает.` : m.choke === 0 ? ' Воздух возвращается.' : ''}`, r.killed ? 'death' : 'damage'))
      if (r.killed) continue
    }
    if (m.petrified) {
      const r = damageMonster(m, rollFormula('1к6').total)
      log.push(entry(`${m.name} окаменел и теряет ${r.dealt} жизней.${r.killed ? ' Рассыпается в прах.' : ''}`, r.killed ? 'death' : 'damage'))
      continue
    }
    if (m.disabled && m.disabled > 0) {
      m.disabled -= 1
      if (m.disabledKind === 'paralysis') {
        const r = damageMonster(m, rollFormula('1к3').total)
        log.push(entry(`${m.name} парализован: −${r.dealt} жизней${m.disabled ? `, ещё ${m.disabled} раунд(ов)` : ''}.${r.killed ? ` ${m.name} погибает.` : ''}`, r.killed ? 'death' : 'damage'))
      } else {
        log.push(entry(`${m.name} ${m.disabledKind === 'sleep' ? 'спит' : m.disabledKind === 'freeze' ? 'вмёрз в лёд' : 'не может действовать'}${m.disabled ? ` (ещё ${m.disabled} раунд(ов))` : ' — приходит в себя'}.`))
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
      const r = k18()
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
  // новый раунд
  state.round += 1
  state.turn = 'heroes'
  state.acted = []
  grantRoundActions(state, heroes, idx)
  for (const h of heroes) {
    h.buffs = h.buffs.filter((b) => b.rounds === -1 || --b.rounds > 0)
    log.push(...tickHeroStatus(h))
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

/** Заклинания, которые монстры применяют сами: урон и контроль */
function monsterSpellOptions(m: MonsterInstance, idx: DataIndex): Spell[] {
  if (!m.spells?.length || !(m.mana ?? 0)) return []
  const byName = new Map<string, Spell>()
  for (const s of idx.data.spells) if (!byName.has(normName(s.name))) byName.set(normName(s.name), s)
  const out: Spell[] = []
  for (const n of m.spells) {
    const s = byName.get(normName(n))
    if (!s) continue
    const e = s.effect
    const usable = e.type === 'damage' || (e.type === 'control' && ['sleep', 'paralysis', 'petrify', 'freeze'].includes(e.kind))
    if (!usable) continue
    const cost = typeof s.cost === 'number' ? s.cost : m.level
    if (cost <= (m.mana ?? 0)) out.push(s)
  }
  return out
}

export function monsterCast(state: CombatState, m: MonsterInstance, heroes: Hero[], idx: DataIndex): LogEntry[] | null {
  const options = monsterSpellOptions(m, idx)
  if (!options.length) return null
  const always = m.attacks === 'magic' || m.attacks === 'none'
  if (!always && k6() > 3) return null
  const spell = options[roll(options.length) - 1]
  const cost = typeof spell.cost === 'number' ? spell.cost : m.level
  m.mana = (m.mana ?? 0) - cost
  const log: LogEntry[] = [entry(`${m.name} произносит «${spell.name}».`, 'spell')]
  const candidates = fightingHeroes(heroes, state)
  if (!candidates.length) return log
  const effect = spell.effect
  const targets = effect.type === 'damage' && effect.targets !== 'one' ? candidates : [candidates[roll(candidates.length) - 1]]
  for (const target of targets) {
    // антимагия: «Воздушный щит», «Огненный щит»
    const ward = hasWard(target, 'antimagic') ?? heroes.map((h) => hasWard(h, 'antimagic')).find((b) => b && (b.charge ?? 0) >= spell.level)
    if (ward) {
      ward.charge = (ward.charge ?? 99) - spell.level
      log.push(entry(`${ward.source} поглощает заклинание (${target.name}).`, 'spell'))
      if ((ward.charge ?? 0) <= 0) for (const h of heroes) h.buffs = h.buffs.filter((b) => b !== ward)
      continue
    }
    if (spell.luck) {
      const r = k18()
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
      const kind = effect.kind === 'sleep' ? 'freeze' : effect.kind
      if (kind === 'freeze' || kind === 'paralysis' || kind === 'petrify') applyExtraAttack(target, kind, log, effect.kind === 'sleep')
    }
  }
  return log
}

export function monsterAttackAlly(m: MonsterInstance, a: AllyInstance): LogEntry[] {
  const r = k18()
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

export function monsterAttack(m: MonsterInstance, target: Hero, idx: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  const def = heroDefense(target, idx)
  const r = k18()
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
    const need = monster?.luckSave?.threshold ?? 10
    const lr = k18()
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
  // дополнительная атака (яд, паралич, окаменение, оледенение)
  if (m.extraAttacks?.length) {
    const ex = m.extraAttacks[0]
    const er = k18()
    if (er >= ex.threshold) {
      const rule = EXTRA_ATTACKS[ex.kind]
      const lr = k18()
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
  const a = rollAttackTable(m.attacks)
  const dmg = Math.max(0, Math.floor((a.damage + m.attackMod) * m.attackMultiplier))
  const delta = changeLives(target, -dmg)
  log.push(entry(`${m.name} атакует ${target.name}: к18 = ${r} ≥ ${def} — попадание, к6 = ${a.roll} → ${-delta} жизней. У ${target.name} ${target.lives}/${target.maxLives}.`, 'damage'))
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
        log.push(entry(`${target.name} засыпает на ${rounds} раунд(ов).`, 'damage'))
        break
      }
      const d = rollFormula('1к18')
      const lost = -limitedLoss(target, d.total)
      target.status.freeze = rounds
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

export function tickHeroStatus(h: Hero): LogEntry[] {
  const log: LogEntry[] = []
  if (!isConscious(h)) return log
  if (h.status.paralysis && h.status.paralysis > 0) {
    const d = rollFormula('1к3')
    const lost = -limitedLoss(h, d.total)
    h.status.paralysis -= 1
    log.push(entry(`${h.name} парализован: −${lost} жизней${h.status.paralysis ? `, ещё ${h.status.paralysis} раунд(ов)` : ', паралич проходит'}.`, 'damage'))
  }
  if (h.status.freeze && h.status.freeze > 0) {
    h.status.freeze -= 1
    if (h.status.freeze === 0) log.push(entry(`${h.name} приходит в себя.`))
  }
  if (h.status.petrified) {
    const d = rollFormula('1к6')
    const lost = -limitedLoss(h, d.total)
    log.push(entry(`${h.name} окаменел: −${lost} жизней.`, 'damage'))
  }
  if (h.status.poison === -1 && h.lives > 0) {
    const lost = -limitedLoss(h, 1)
    log.push(entry(`${h.name} страдает от яда: −${lost} жизнь.`, 'damage'))
  }
  return log
}

/** Завершение боя: снять боевые статусы и баффы */
export function finishCombat(state: CombatState, heroes: Hero[]): LogEntry[] {
  const log: LogEntry[] = []
  for (const h of heroes) {
    h.buffs = h.buffs.filter((b) => b.stat === 'ward' && b.ward === 'luck')
    delete h.status.petrified
    delete h.status.freeze
    delete h.status.paralysis
  }
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
