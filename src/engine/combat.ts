/** Бой (стр. 17–19 Инструкции): раунды, инициатива, атаки, храбрость, доп. атаки, бегство. */
import type { Monster } from '@/types'
import type { DataIndex } from './data'
import type { CombatState, EquipSlot, Hero, LogEntry, MonsterInstance } from './model'
import { uid } from './model'
import { changeLives, gainXp, heroAccuracy, heroDefense, heroDexterity, heroLuck, heroStrength, heroWeapons, isActive, isConscious, levelRow, UNARMED, type HandWeapon, type LevelUp } from './character'
import { k18, k6, roll, rollAttackTable, rollFormula } from './dice'
import { EXTRA_ATTACKS, fleeTarget } from './rules'

export interface EncounterSpec {
  monsterId: string
  count: number
}

function entry(text: string, kind: LogEntry['kind'] = 'info'): LogEntry {
  return { t: Date.now(), text, kind }
}

export function makeMonsterInstance(m: Monster, n: number): MonsterInstance {
  const attacks = Array.isArray(m.attacks) ? m.attacks : m.attacks === 'death' ? 'death' : [1, 1, 1, 2, 2, 2]
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
    acted: [],
    escaped: [],
    returnTo,
    xpEarned: {},
  }
  const log = [entry(`Бой начинается: ${monsters.map((m) => m.name).join(', ')}. Первый раунд — дистанция: метательное оружие и заклинания.`)]
  return { state, log }
}

/** Бросок инициативы перед ближним боем: к18 с каждой стороны, при равенстве перебрасывается */
export function rollInitiative(state: CombatState): LogEntry {
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

export function fightingHeroes(heroes: Hero[], state: CombatState): Hero[] {
  return heroes.filter((h) => !state.escaped.includes(h.uid) && isConscious(h))
}

export function activeHeroes(heroes: Hero[], state: CombatState): Hero[] {
  return heroes.filter((h) => !state.escaped.includes(h.uid) && isActive(h))
}

export function damageMonster(m: MonsterInstance, amount: number): { dealt: number; killed: boolean } {
  const dealt = Math.max(0, Math.min(amount, Math.max(0, m.lives)))
  m.lives -= Math.max(0, amount)
  if (m.lives <= 0) {
    m.dead = true
  }
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

/** Атака героя оружием (слот) или без оружия */
export function heroAttack(state: CombatState, hero: Hero, heroes: Hero[], weaponSlot: EquipSlot | 'unarmed', targetUid: string, idx: DataIndex): AttackOutcome {
  const out: AttackOutcome = { log: [], hit: false, damage: 0, killed: false, xp: 0, levelUps: [] }
  const target = aliveMonsters(state).find((m) => m.uid === targetUid)
  if (!target) { out.log.push(entry('Цель не найдена')); return out }
  if (!isActive(hero)) { out.log.push(entry(`${hero.name} не может действовать`)); return out }
  const weapons = heroWeapons(hero, idx)
  let w: HandWeapon | null = weaponSlot === 'unarmed' ? null : weapons.find((x) => x.slot === weaponSlot) ?? null
  const ranged = !!w?.ranged
  if (state.phase === 'ranged' && !ranged) {
    out.log.push(entry('На дистанции можно только стрелять или колдовать. Переходите в ближний бой.'))
    return out
  }
  if (state.phase === 'melee' && ranged && w?.entry.kind === 'weapon' && !idx.weapon(w.entry.ref).throwable) {
    // ХАУСРУЛ: луки и арбалеты в ближнем бою не используются; дротики и копья — можно
    out.log.push(entry('Противник вплотную — из лука уже не выстрелить.'))
    return out
  }
  const name = w?.name ?? 'голые руки'
  const bonus = ranged ? heroAccuracy(hero, idx) + (w?.accuracyBonus ?? 0) : heroDexterity(hero)
  const need = target.defense + target.defenseMod
  const r = k18()
  const hit = w?.alwaysHits || r + bonus >= need
  out.log.push(entry(`${hero.name} атакует ${target.name} (${name}): к18 = ${r}${bonus ? ` + ${bonus}` : ''} против защиты ${need} — ${hit ? 'попадание' : 'промах'}.`, hit ? 'hit' : 'miss'))
  if (!hit) {
    out.log.push(...markActed(state, hero, heroes))
    return out
  }
  out.hit = true
  const table = w?.attacks ?? UNARMED
  let total = 0
  const parts: string[] = []
  const rollsCount = w?.doubleDamage ? 2 : 1
  for (let i = 0; i < rollsCount; i++) {
    const a = rollAttackTable(table)
    total += a.damage
    parts.push(`к6 = ${a.roll} → ${a.damage}`)
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
  if (w?.poisoned) {
    const p = rollFormula('1к18')
    total += p.total
    const rounds = k6()
    target.poison = (target.poison ?? 0) + rounds
    w.entry.poisoned = false
    parts.push(`яд +${p.total}, действует ${rounds} раунд(ов)`)
  }
  const d = damageMonster(target, total)
  out.damage = d.dealt
  out.killed = d.killed
  const xp = awardXp(state, hero, d.dealt, target, idx)
  out.xp = xp.xp
  out.levelUps = xp.levelUps
  out.log.push(entry(`${target.name} теряет ${d.dealt} жизней (${parts.join(', ')}).${d.killed ? ` ${target.name} повержен!` : ` Осталось ${Math.max(0, target.lives)}.`}`, d.killed ? 'death' : 'damage'))
  if (xp.xp) out.log.push(entry(`${hero.name} получает ${xp.xp} очков опыта.`, 'xp'))
  for (const up of xp.levelUps) out.log.push(entry(`${hero.name} достигает ${up.level} уровня!`, 'xp'))
  out.log.push(...markActed(state, hero, heroes))
  return out
}

/** Попытка бегства: к18 против таблицы по уровню самого сильного монстра */
export function heroFlee(state: CombatState, hero: Hero, heroes: Hero[]): LogEntry[] {
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
  log.push(...markActed(state, hero, heroes))
  return log
}

export function heroSkip(state: CombatState, hero: Hero, heroes: Hero[]): LogEntry[] {
  return [entry(`${hero.name} пропускает ход.`), ...markActed(state, hero, heroes)]
}

/**
 * Отмечает действие героя. Когда все активные герои сходили: на дистанции — переход в ближний бой
 * с броском инициативы, в ближнем бою — ход монстров.
 */
export function markActed(state: CombatState, hero: Hero, heroes: Hero[]): LogEntry[] {
  if (!state.acted.includes(hero.uid)) state.acted.push(hero.uid)
  checkEnd(state, heroes)
  if (state.finished) return []
  const pending = activeHeroes(heroes, state).filter((h) => !state.acted.includes(h.uid))
  if (pending.length > 0) return []
  if (state.phase === 'ranged') return [closeToMelee(state)]
  state.turn = 'monsters'
  return []
}

/** Завершить фазу дистанции и перейти к ближнему бою (бросок инициативы) */
export function closeToMelee(state: CombatState): LogEntry {
  state.phase = 'melee'
  state.acted = []
  return rollInitiative(state)
}

export function checkEnd(state: CombatState, heroes: Hero[]): void {
  if (state.finished) return
  if (aliveMonsters(state).length === 0) {
    state.finished = 'victory'
    return
  }
  const fighters = heroes.filter((h) => !state.escaped.includes(h.uid))
  if (fighters.length === 0 || fighters.every((h) => !isConscious(h))) {
    state.finished = state.escaped.length > 0 && fighters.every((h) => !isConscious(h)) && fighters.length === 0 ? 'fled' : fighters.length === 0 ? 'fled' : 'defeat'
  }
}

/** Ход монстров: статусы, храбрость, атаки. Затем новый раунд. */
export function monstersTurn(state: CombatState, heroes: Hero[], idx: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  if (state.finished) return log
  for (const m of aliveMonsters(state)) {
    // статусы монстра
    if (m.poison && m.poison > 0) {
      const d = rollFormula('1к6')
      const r = damageMonster(m, d.total)
      m.poison -= 1
      log.push(entry(`${m.name} страдает от яда: −${r.dealt} жизней.${r.killed ? ` ${m.name} погибает.` : ''}`, r.killed ? 'death' : 'damage'))
      if (r.killed) continue
    }
    if (m.petrified) {
      const d = rollFormula('1к6')
      const r = damageMonster(m, d.total)
      log.push(entry(`${m.name} окаменел и теряет ${r.dealt} жизней.${r.killed ? ' Рассыпается в прах.' : ''}`, r.killed ? 'death' : 'damage'))
      continue
    }
    if (m.disabled && m.disabled > 0) {
      m.disabled -= 1
      log.push(entry(`${m.name} не может действовать (ещё ${m.disabled} раунд(ов)).`))
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
    const targets = fightingHeroes(heroes, state)
    if (!targets.length) break
    const target = targets[roll(targets.length) - 1]
    log.push(...monsterAttack(m, target, idx))
    checkEnd(state, heroes)
    if (state.finished) break
  }
  checkEnd(state, heroes)
  if (state.finished) return log
  // новый раунд
  state.round += 1
  state.turn = 'heroes'
  state.acted = []
  for (const h of heroes) {
    h.buffs = h.buffs.filter((b) => b.rounds === -1 || --b.rounds > 0)
    log.push(...tickHeroStatus(h))
  }
  checkEnd(state, heroes)
  if (!state.finished && activeHeroes(heroes, state).length === 0 && fightingHeroes(heroes, state).length > 0) {
    // все живые герои обездвижены — монстры ходят снова
    log.push(entry('Никто из героев не может действовать — ход снова переходит к монстрам.'))
    state.turn = 'monsters'
  }
  log.push(entry(`— Раунд ${state.round} —`))
  return log
}

export function monsterAttack(m: MonsterInstance, target: Hero, idx: DataIndex): LogEntry[] {
  const log: LogEntry[] = []
  const def = heroDefense(target, idx)
  const r = k18()
  if (r < def) {
    log.push(entry(`${m.name} атакует ${target.name}: к18 = ${r} против защиты ${def} — промах.`, 'miss'))
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
  let dmg = Math.max(0, Math.floor((a.damage + m.attackMod) * m.attackMultiplier))
  const delta = changeLives(target, -dmg)
  log.push(entry(`${m.name} атакует ${target.name}: к18 = ${r} ≥ ${def} — попадание, к6 = ${a.roll} → ${-delta} жизней. У ${target.name} ${target.lives}/${target.maxLives}.`, 'damage'))
  if (target.status.dead) log.push(entry(`${target.name} погибает.`, 'death'))
  else if (target.status.unconscious) log.push(entry(`${target.name} теряет сознание.`, 'death'))
  return log
}

export function applyExtraAttack(target: Hero, kind: keyof typeof EXTRA_ATTACKS, log: LogEntry[]): void {
  switch (kind) {
    case 'freeze': {
      const d = rollFormula('1к18')
      const lost = -limitedLoss(target, d.total)
      const rounds = k6()
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
    if (h.status.freeze === 0) log.push(entry(`${h.name} оттаивает.`))
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
    h.buffs = []
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
