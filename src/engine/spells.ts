/** Заклинания: стоимость, применение эффектов, опыт. */
import type { Spell, SpellEffect } from '@/types'
import type { DataIndex } from './data'
import type { AllyInstance, CombatState, Hero, InventoryEntry, LogEntry, MonsterInstance } from './model'
import { changeLives, gainXp, hasWard, heroDefense, isConscious, type LevelUp } from './character'
import { k18, k6, roll, rollFormula } from './dice'
import { addToInventory } from './inventory'
import { BOTTLES } from './rules'
import { UNDEAD, damageMonster, makeAlly, makeMonsterInstance } from './combat'

export interface CastInput {
  hero: Hero
  spell: Spell
  idx: DataIndex
  heroes: Hero[]
  combat?: CombatState | null
  /** цель-монстр */
  targetUid?: string
  /** цель-герой */
  targetHeroUid?: string
  /** цель-предмет (опознание): uid записи инвентаря у любого героя */
  targetEntryUid?: string
  /** параметр: число стрел, маны на лечение и т.п. */
  param?: number
}

export interface CastResult {
  ok: boolean
  log: LogEntry[]
  manaSpent: number
  xp: number
  damage: number
  levelUps: LevelUp[]
  escaped?: boolean
}

const L = (hero: Hero) => Math.max(1, hero.level)

/** Стоимость в мане: число или формула из текста; при «Бесконечной мане» — 0 */
export function resolveCost(spell: Spell, hero: Hero, param?: number): number {
  if (hasWard(hero, 'infinite-mana')) return 0
  if (spell.cost !== null && spell.cost !== undefined) return spell.cost
  const f = (spell.costFormula ?? '').toLowerCase()
  if (/за 2 уровня/.test(f)) return Math.ceil(L(hero) / 2)
  if (/за (1 )?уровень/.test(f)) return L(hero)
  if (/за 1 стрел/.test(f)) return Math.min(3, Math.max(1, param ?? 1))
  if (/за 3 ман/.test(f)) return Math.max(1, param ?? 1)
  return Math.max(0, param ?? 0)
}

/** Заклинания, которые имеют смысл вне боя */
export function usableOutOfCombat(spell: Spell): boolean {
  const t = spell.effect.type
  return ['heal', 'restore-all', 'cure', 'resurrect', 'identify', 'create-bottle', 'restore-mana', 'initiative', 'manual', 'buff', 'ward'].includes(t)
}

export function needsMonsterTarget(spell: Spell): boolean {
  const e = spell.effect
  return (e.type === 'damage' && e.targets === 'one') || (e.type === 'debuff' && e.scope === 'one') || (e.type === 'control' && e.targets === 'one') || e.type === 'drain-mana'
}

export function needsHeroTarget(spell: Spell): boolean {
  const e = spell.effect
  return e.type === 'heal' || e.type === 'restore-all' || (e.type === 'buff' && e.scope === 'ally') || (e.type === 'ward' && e.scope === 'ally') || ['cure', 'resurrect', 'restore-mana', 'initiative', 'extra-action'].includes(e.type)
}

export function needsEntryTarget(spell: Spell): boolean {
  return spell.effect.type === 'identify'
}

export function needsParam(spell: Spell): boolean {
  return spell.effect.type === 'heal' || spell.effect.type === 'drain-mana' || spell.effect.type === 'restore-mana' || /стрел/.test(spell.costFormula ?? '')
}

export function canCast(hero: Hero, spell: Spell, idx: DataIndex, param?: number): string | null {
  const cls = idx.cls(hero.classId)
  if (!cls.caster) return `${cls.name} не владеет магией`
  if (cls.caster !== spell.caster) return 'Заклинание другого класса'
  if (!hero.spellbook.includes(spell.id)) return 'Заклинания нет в книге'
  const cost = resolveCost(spell, hero, param)
  if (hero.mana < cost) return `Не хватает маны (нужно ${cost}, есть ${hero.mana})`
  return null
}

function durationRounds(duration: string | undefined, level: number): number {
  const d = (duration ?? '').toLowerCase()
  if (!d) return -1
  if (/бой/.test(d)) return -1
  if (/1к6 раунд/.test(d)) return rollFormula('1к6').total
  if (/за 2 уровня/.test(d)) return Math.max(1, Math.ceil(level / 2))
  if (/за (1 )?уровень/.test(d)) return Math.max(1, level)
  const m = d.match(/(\d+)\s*раунд/)
  if (m) return parseInt(m[1], 10)
  return -1
}

function parseAmount(amount: number | string, hero: Hero, stat?: string, currentDefense?: number): { value: number; multiplier: boolean } {
  if (typeof amount === 'number') return { value: amount, multiplier: false }
  const a = amount.toLowerCase().replace(/\s+/g, '')
  // таблица "уровень 2→12, 3→13, ..." — абсолютное значение защиты призрачного доспеха
  if (a.startsWith('уровень')) {
    const pairs = [...a.matchAll(/(\d+)→(\d+)/g)].map((m) => [parseInt(m[1], 10), parseInt(m[2], 10)] as const)
    let value = 0
    for (const [lvl, v] of pairs) if (hero.level >= lvl) value = v
    if (!value && pairs.length) value = pairs[0][1]
    if (stat === 'defense' && currentDefense !== undefined) return { value: Math.max(0, value - currentDefense), multiplier: false }
    return { value, multiplier: false }
  }
  const mult = a.match(/^[x×*](\d+(?:[.,]\d+)?)$/)
  if (mult) return { value: parseFloat(mult[1].replace(',', '.')), multiplier: true }
  if (/впол|\/2$/.test(a)) return { value: 0.5, multiplier: true }
  const perLevel = a.match(/^([+-]?\d+)(?:мана|маны)?за(\d+)?уров/)
  if (perLevel) {
    const per = parseInt(perLevel[1], 10)
    const div = perLevel[2] ? parseInt(perLevel[2], 10) : 1
    return { value: per * Math.floor(L(hero) / div), multiplier: false }
  }
  const n = parseInt(a, 10)
  return { value: isNaN(n) ? 0 : n, multiplier: false }
}

/**
 * Бросок урона заклинания. Форматы dice из spells.json:
 * "1к6", "3к18", "3к6+8" — обычная формула; "2" + perLevel — число за уровень (max — потолок);
 * "1к3" + perLevel — бросок за каждый уровень; "1k6 за 2 уровня мага" — бросок за каждые N уровней;
 * "половина жизней" — половина текущих жизней цели.
 */
export function rollSpellDamage(effect: Extract<SpellEffect, { type: 'damage' }>, level: number, targetLives = 0): { total: number; detail: string } {
  const lvl = Math.max(1, level)
  const raw = effect.dice.trim().toLowerCase()
  if (/половин/.test(raw)) return { total: Math.ceil(Math.max(0, targetLives) / 2), detail: 'половина жизней' }
  const per = raw.match(/^(\S+)\s+за\s+(\d+)\s+уров/)
  const dice = (per ? per[1] : raw).replace(/\s+/g, '')
  const divisor = per ? parseInt(per[2], 10) : 1
  const times = per ? Math.max(1, Math.floor(lvl / divisor)) : effect.perLevel ? lvl : 1
  let total = 0
  let detail: string
  if (/[kк]/.test(dice)) {
    const rolls: number[] = []
    for (let i = 0; i < times; i++) rolls.push(rollFormula(dice).total)
    total = rolls.reduce((a, b) => a + b, 0)
    detail = times > 1 ? `${dice} × ${times} = ${rolls.join('+')}` : `${dice}: ${rolls[0]}`
  } else {
    const n = parseInt(dice, 10) || 0
    total = n * times
    detail = times > 1 ? `${n} × ${times} уровней` : `${n}`
  }
  if (effect.max) total = Math.min(total, effect.max)
  return { total, detail }
}

function spellXp(spell: Spell, hero: Hero, measured: { damageXp: number; healed: number; manaMoved: number }): number {
  if (typeof spell.xp === 'number') return spell.xp
  const f = (spell.xpFormula ?? '').toLowerCase()
  if (/отнят|мертвец/.test(f)) return measured.damageXp
  let m = f.match(/(\d+)\s*(?:очк\S*\s*)?за\s*1\s*(жизнь|получ)/)
  if (m) return parseInt(m[1], 10) * (/ману/.test(f) ? measured.manaMoved : measured.healed)
  m = f.match(/(\d+)\s*(очков\s*)?за\s*2\s*уровн/)
  if (m) return parseInt(m[1], 10) * Math.ceil(L(hero) / 2)
  m = f.match(/(\d+)\s*(очков\s*)?за\s*уров/)
  if (m) return parseInt(m[1], 10) * L(hero)
  return 0
}

function log(entries: LogEntry[], text: string, kind: LogEntry['kind'] = 'spell') {
  entries.push({ t: Date.now(), text, kind })
}

/** Бросок удачи монстра от заклинания: true — увернулся */
function monsterSaves(m: MonsterInstance, spell: Spell, entries: LogEntry[]): boolean {
  if (!spell.luck) return false
  if (m.noSave) { log(entries, `${m.name} не может сопротивляться заклинанию.`, 'luck'); return false }
  const r = k18()
  const ok = r >= spell.luck
  log(entries, `${m.name} бросает удачу от заклинания: ${r} ${ok ? '≥' : '<'} ${spell.luck} — ${ok ? 'увернулся' : 'не увернулся'}.`, 'luck')
  return ok
}

function findEntry(heroes: Hero[], uid: string): { owner: Hero; entry: InventoryEntry } | null {
  for (const h of heroes) {
    const e = h.inventory.find((x) => x.uid === uid)
    if (e) return { owner: h, entry: e }
  }
  return null
}

function summonLives(formula: string | undefined, level: number, hero: Hero): number {
  const f = (formula ?? '10').replace(/\s+/g, '').toLowerCase()
  if (/^\d+$/.test(f)) return parseInt(f, 10)
  let m = f.match(/^(\d+)\*l$/)
  if (m) return parseInt(m[1], 10) * Math.max(1, level)
  m = f.match(/^(\d+)\+l$/)
  if (m) return parseInt(m[1], 10) + Math.max(1, level)
  if (/макс/.test(f)) return Math.min(40, hero.maxLives * 2)
  return 10
}

/** Применить заклинание. Мутирует героя, цели и состояние боя. */
export function castSpell(input: CastInput): CastResult {
  const { hero, spell, idx, heroes, combat } = input
  const entries: LogEntry[] = []
  const res: CastResult = { ok: false, log: entries, manaSpent: 0, xp: 0, damage: 0, levelUps: [] }
  const why = canCast(hero, spell, idx, input.param)
  if (why) { log(entries, `${hero.name}: ${why}`, 'info'); return res }
  const cost = resolveCost(spell, hero, input.param)
  const effect = spell.effect ?? { type: 'manual' }
  const measured = { damageXp: 0, healed: 0, manaMoved: 0 }
  const aliveMonsters = () => (combat?.monsters ?? []).filter((m) => !m.dead && !m.fled)
  const targetHero = () => heroes.find((h) => h.uid === (input.targetHeroUid ?? hero.uid)) ?? hero
  const fail = (text: string) => { log(entries, text, 'info'); return res }
  const spend = () => { hero.mana -= cost; res.manaSpent = cost; log(entries, `${hero.name} произносит «${spell.name}»${cost ? ` (−${cost} маны)` : ''}.`) }
  const needCombat = () => (!combat ? fail('Это заклинание применяется только в бою') : null)
  const oneMonster = () => {
    const t = aliveMonsters().find((m) => m.uid === input.targetUid)
    return t ?? null
  }

  switch (effect.type) {
    case 'damage': {
      if (needCombat()) return res
      let targets: MonsterInstance[]
      if (effect.targets === 'one') {
        const t = oneMonster()
        if (!t) return fail('Нужно выбрать цель')
        targets = [t]
      } else targets = aliveMonsters().slice(0, effect.targets === 'many' ? 10 : undefined)
      spend()
      const volleys = /за 1 стрел/.test(spell.costFormula ?? '') ? Math.min(3, Math.max(1, input.param ?? 1)) : 1
      for (const t of targets) {
        for (let v = 0; v < volleys; v++) {
          let half = false
          if (spell.luck && !t.noSave) {
            const r = k18()
            if (r >= spell.luck) {
              if (/magicheskiy-shar/.test(spell.id)) half = true
              else { log(entries, `${t.name} бросает удачу от заклинания: ${r} ≥ ${spell.luck} — увернулся.`, 'luck'); continue }
              log(entries, `${t.name} бросает удачу от заклинания: ${r} ≥ ${spell.luck} — урон вдвое меньше.`, 'luck')
            } else log(entries, `${t.name} бросает удачу от заклинания: ${r} < ${spell.luck} — не увернулся.`, 'luck')
          }
          if (effect.slayBelow && t.level < effect.slayBelow) {
            const d = damageMonster(t, Math.max(1, t.lives))
            measured.damageXp += d.dealt * t.points
            res.damage += d.dealt
            log(entries, `${t.name} (уровень ${t.level} < ${effect.slayBelow}) гибнет на месте!`, 'death')
            continue
          }
          const dmg = rollSpellDamage(effect, hero.level, t.lives)
          const amount = half ? Math.floor(dmg.total / 2) : dmg.total
          const d = damageMonster(t, amount)
          res.damage += d.dealt
          measured.damageXp += d.dealt * t.points
          log(entries, `${t.name} теряет ${d.dealt} жизней (${dmg.detail}).${d.killed ? ` ${t.name} повержен!` : ` Осталось ${Math.max(0, t.lives)}.`}`, d.killed ? 'death' : 'damage')
        }
      }
      break
    }
    case 'heal': {
      const target = targetHero()
      const manaPerLife = Math.max(1, Math.round(1 / effect.perMana))
      const want = Math.max(1, input.param ?? 1)
      const missing = Math.max(0, target.maxLives - target.lives)
      let use = Math.min(want, hero.mana, missing * manaPerLife)
      use -= use % manaPerLife
      if (use <= 0) return fail(`${target.name} не нуждается в лечении`)
      hero.mana -= use
      res.manaSpent = use
      const healed = changeLives(target, Math.floor(use * effect.perMana))
      measured.healed = healed
      log(entries, `${hero.name} — «${spell.name}»: ${target.name} +${healed} жизней за ${use} маны.`)
      break
    }
    case 'restore-all': {
      const target = targetHero()
      spend()
      const healed = changeLives(target, target.maxLives - target.lives)
      measured.healed = healed
      log(entries, `${target.name} восстанавливает все жизни (+${healed}).`)
      break
    }
    case 'buff': {
      spend()
      const { value, multiplier } = parseAmount(effect.amount, hero, effect.stat, effect.stat === 'defense' ? heroDefense(hero, idx) : undefined)
      const rounds = durationRounds(effect.duration ?? spell.duration, hero.level)
      const targets = effect.scope === 'party' ? heroes.filter((h) => !h.status.dead) : effect.scope === 'ally' ? [targetHero()] : [hero]
      for (const t of targets) t.buffs.push({ source: spell.name, stat: effect.stat, amount: value, multiplier, rounds })
      log(entries, `${targets.map((t) => t.name).join(', ')}: ${statName(effect.stat)} ${multiplier ? `×${value}` : (value >= 0 ? '+' : '') + value}${rounds > 0 ? ` на ${rounds} раунд(ов)` : ' до конца боя'}.`)
      break
    }
    case 'debuff': {
      if (needCombat()) return res
      const targets = effect.scope === 'one' ? [oneMonster()].filter((m): m is MonsterInstance => !!m) : aliveMonsters()
      if (!targets.length) return fail('Нет цели')
      spend()
      const { value, multiplier } = parseAmount(effect.amount, hero, effect.stat)
      for (const t of targets) {
        if (effect.stat === 'defense') t.defenseMod += value
        else if (multiplier) t.attackMultiplier *= value
        else t.attackMod += value
      }
      log(entries, `${targets.map((t) => t.name).join(', ')}: ${statName(effect.stat)} ${multiplier ? `×${value}` : (value >= 0 ? '+' : '') + value}.`)
      break
    }
    case 'escape': {
      spend()
      log(entries, 'Враги теряют вас из виду — команда беспрепятственно уходит.', 'flee')
      res.escaped = true
      if (combat) combat.finished = 'fled'
      break
    }
    case 'control': {
      if (needCombat()) return res
      const all = aliveMonsters()
      let targets: MonsterInstance[]
      if (effect.kind === 'return') {
        const fled = (combat?.monsters ?? []).filter((m) => m.fled && !m.dead)
        const t = fled.find((m) => m.uid === input.targetUid) ?? fled[0]
        if (!t) return fail('Никто не сбежал')
        spend()
        t.fled = false
        t.courageChecked = true
        log(entries, `${t.name} возвращается в бой, исполненный храбрости.`)
        break
      }
      if (effect.targets === 'one') {
        const t = oneMonster()
        if (!t) return fail('Нужно выбрать цель')
        targets = [t]
      } else targets = all
      spend()
      for (const t of targets) {
        if (effect.maxLevel !== undefined && t.level > effect.maxLevel) { log(entries, `${t.name} слишком силён (уровень ${t.level} > ${effect.maxLevel}) — заклинание не действует.`); continue }
        if (effect.kind === 'slay-undead' && !UNDEAD.has(t.monsterId)) { log(entries, `${t.name} — не мертвец, заклинание бессильно.`); continue }
        if (monsterSaves(t, spell, entries)) continue
        applyControl(effect.kind, t, hero, spell, combat!, effect.duration, entries, measured)
      }
      break
    }
    case 'weapon': {
      spend()
      const rounds = durationRounds(effect.duration, hero.level)
      hero.buffs = hero.buffs.filter((b) => b.stat !== 'weapon')
      hero.buffs.push({ source: spell.name, stat: 'weapon', amount: 0, rounds, weapon: { name: effect.name, attacks: effect.attacks, dexterityBonus: effect.dexterityBonus, attacksPerRound: effect.attacksPerRound, lifesteal: effect.lifesteal } })
      log(entries, `В руках ${hero.name} возникает ${effect.name}: атаки ${effect.attacks}${effect.dexterityBonus ? `, ловкость +${effect.dexterityBonus}` : ''}${effect.attacksPerRound ? `, ${effect.attacksPerRound} удара за ход` : ''}. Действует до конца боя.`)
      break
    }
    case 'ward': {
      spend()
      const rounds = durationRounds(effect.duration, hero.level)
      const targets = effect.scope === 'party' ? heroes.filter((h) => !h.status.dead) : effect.scope === 'ally' ? [targetHero()] : [hero]
      const charge = effect.kind === 'antimagic' ? (effect.scope === 'party' ? rollFormula('2к6').total : 99) : undefined
      for (const t of targets) {
        t.buffs = t.buffs.filter((b) => !(b.stat === 'ward' && b.ward === effect.kind))
        t.buffs.push({ source: spell.name, stat: 'ward', ward: effect.kind, amount: 0, rounds, charge })
      }
      log(entries, `${targets.map((t) => t.name).join(', ')}: ${wardName(effect.kind)}${charge && charge < 99 ? ` (поглотит ${charge} уровней заклинаний)` : ''}${rounds > 0 ? ` на ${rounds} раунд(ов)` : ''}.`)
      break
    }
    case 'initiative': {
      spend()
      const t = targetHero()
      t.status.initiative = true
      log(entries, `${t.name} в ближайшем бою атакует первым.`)
      break
    }
    case 'extra-action': {
      if (needCombat()) return res
      spend()
      const t = targetHero()
      combat!.extraActions[t.uid] = (combat!.extraActions[t.uid] ?? 0) + 1
      combat!.acted = combat!.acted.filter((u) => u !== t.uid)
      log(entries, `Время замирает: ${t.name} получает дополнительное действие без ответа противника.`)
      break
    }
    case 'create-bottle': {
      spend()
      const n = k6()
      addToInventory(hero, 'bottle', String(n), 1, { identified: true })
      log(entries, `к6 = ${n}: появляется бутылка (${n}) — ${BOTTLES[n - 1].label}.`)
      break
    }
    case 'identify': {
      if (!input.targetEntryUid) return fail('Выберите предмет для опознания')
      const found = findEntry(heroes, input.targetEntryUid)
      if (!found) return fail('Предмет не найден')
      spend()
      const e = found.entry
      if (e.kind === 'bottle') {
        const n = parseInt(e.ref, 10)
        const wrong = roll(6) === 1
        const truth = BOTTLES[n - 1]
        const shown = wrong ? BOTTLES[(n + 2) % 6] : truth
        if (!wrong) e.identified = true
        log(entries, `Опознание бутылки у ${found.owner.name}: ${shown.label}.${wrong ? '' : ''}`)
      } else if (e.kind === 'scroll') {
        e.identified = true
        log(entries, `Свиток у ${found.owner.name}: «${idx.spell(e.ref).name}».`)
      } else if (e.kind === 'artifact') {
        log(entries, `${idx.artifact(parseInt(e.ref, 10)).name}: ${idx.artifact(parseInt(e.ref, 10)).description}`)
      } else log(entries, 'Назначение этого предмета и так очевидно.')
      break
    }
    case 'drain-mana': {
      if (needCombat()) return res
      const t = oneMonster()
      if (!t) return fail('Нужно выбрать цель')
      if (!(t.mana ?? 0)) { spend(); log(entries, `У ${t.name} нет магической энергии — мана потрачена впустую.`); break }
      if (monsterSaves(t, spell, entries)) { hero.mana -= cost; res.manaSpent = cost; break }
      const use = Math.max(1, Math.min(input.param ?? 1, hero.mana))
      hero.mana -= use
      res.manaSpent = use
      const gained = Math.min(use * effect.ratio, t.mana ?? 0, hero.maxMana - hero.mana)
      t.mana = (t.mana ?? 0) - gained
      hero.mana += gained
      measured.manaMoved = gained
      log(entries, `${hero.name} выкачивает из ${t.name} ${gained} маны (потрачено ${use}).`)
      break
    }
    case 'restore-mana': {
      const t = targetHero()
      if (t.uid === hero.uid) return fail('На себя это заклинание не действует')
      const use = Math.max(1, Math.min(input.param ?? 1, hero.mana))
      const gained = Math.min(use * effect.ratio, t.maxMana - t.mana)
      if (gained <= 0) return fail(`${t.name} не нуждается в мане`)
      hero.mana -= use
      res.manaSpent = use
      t.mana += gained
      measured.manaMoved = gained
      log(entries, `${t.name} восстанавливает ${gained} маны (потрачено ${use}).`)
      break
    }
    case 'cure': {
      const t = targetHero()
      const s = t.status
      if (!s.poison && !s.paralysis && !s.petrified && !s.freeze) return fail(`${t.name} не нуждается в эликсире`)
      spend()
      delete s.poison; delete s.paralysis; delete s.petrified; delete s.freeze
      log(entries, `Несколько капель эликсира — и ${t.name} исцелён.`)
      break
    }
    case 'resurrect': {
      const t = targetHero()
      if (t.uid === hero.uid) return fail('Оживить самого себя невозможно')
      if (!t.status.dead) return fail(`${t.name} жив`)
      spend()
      t.status = {}
      t.lives = t.maxLives // ХАУСРУЛ: ожившие возвращаются с полным здоровьем
      t.buffs = []
      log(entries, `Боги возвращают душу: ${t.name} снова жив.`)
      break
    }
    case 'summon': {
      if (needCombat()) return res
      spend()
      const ally = buildSummon(effect, hero, idx, entries, combat!)
      if (ally) combat!.allies.push(ally)
      break
    }
    case 'empower': {
      if (needCombat()) return res
      const own = combat!.allies.filter((a) => a.ownerUid === hero.uid && !a.dead && !a.decoy)
      const a = own[own.length - 1]
      if (!a) return fail('Нет созданного существа')
      spend()
      a.attackMultiplier *= 2
      a.lives += 2 * L(hero); a.maxLives += 2 * L(hero); a.defense += 2
      log(entries, `${a.name} усилен: атаки ×2, жизни +${2 * L(hero)}, защита +2.`)
      break
    }
    default: {
      spend()
      log(entries, `Эффект по описанию: ${spell.description}`)
    }
  }
  res.ok = true
  const xp = spellXp(spell, hero, measured)
  if (xp > 0) {
    res.xp = xp
    res.levelUps = gainXp(hero, xp, idx)
    log(entries, `${hero.name} получает ${xp} очков опыта.`, 'xp')
  }
  return res
}

function applyControl(kind: Extract<SpellEffect, { type: 'control' }>['kind'], t: MonsterInstance, hero: Hero, spell: Spell, combat: CombatState, duration: string | undefined, entries: LogEntry[], measured: { damageXp: number }): void {
  switch (kind) {
    case 'sleep': {
      t.disabled = durationRounds(duration, hero.level)
      t.disabledKind = 'sleep'
      log(entries, `${t.name} засыпает на ${t.disabled} раунд(ов) и беззащитен.`)
      break
    }
    case 'paralysis': {
      t.disabled = k6()
      t.disabledKind = 'paralysis'
      log(entries, `${t.name} парализован на ${t.disabled} раунд(ов), теряет 1к3 жизней за раунд.`)
      break
    }
    case 'petrify':
      t.petrified = true
      log(entries, `${t.name} превращается в камень и будет терять 1к6 жизней за раунд.`)
      break
    case 'freeze': {
      const d = damageMonster(t, rollFormula('1к18').total)
      measured.damageXp += d.dealt * t.points
      t.disabled = k6()
      t.disabledKind = 'freeze'
      log(entries, `${t.name} превращается в глыбу льда: −${d.dealt} жизней, ${t.disabled} раунд(ов) без движения.${d.killed ? ` ${t.name} погибает.` : ''}`, d.killed ? 'death' : 'damage')
      break
    }
    case 'web': {
      const d = damageMonster(t, Math.ceil(t.lives / 2))
      measured.damageXp += d.dealt * t.points
      log(entries, `${t.name} запутывается в паутине и теряет ${d.dealt} жизней.${d.killed ? ` ${t.name} погибает.` : ''}`, d.killed ? 'death' : 'damage')
      break
    }
    case 'fear':
      if (t.level <= 2) { t.fled = true; log(entries, `${t.name} в панике покидает поле боя!`, 'flee') }
      else { t.attackMod -= 2; log(entries, `${t.name} охвачен страхом: атаки −2.`) }
      break
    case 'hold':
      if (!t.held) { t.held = true; t.defenseMod -= 2; t.attackMultiplier *= 0.5 }
      log(entries, `Гигантская рука хватает ${t.name}: защита −2, атаки вдвое слабее.`)
      break
    case 'choke': {
      if (!t.choke) { t.defenseMod -= 4; t.attackMultiplier *= 0.5 }
      t.choke = Math.max(t.choke ?? 0, durationRounds(duration, hero.level))
      log(entries, `${t.name} задыхается: защита −4, атаки вдвое, −1к3 жизней за раунд (${t.choke} раунд(ов)).`)
      break
    }
    case 'charm': {
      t.fled = true
      const table = Array.isArray(t.attacks) ? t.attacks.join('-') : '1-1-1-2-2-2'
      combat.allies.push(makeAlly(hero.uid, `${t.name} (очарован)`, t.defense, table, Math.max(1, t.lives)))
      log(entries, `${t.name} загипнотизирован и переходит на сторону ${hero.name}.`)
      break
    }
    case 'slay':
    case 'slay-undead': {
      const d = damageMonster(t, Math.max(1, t.lives))
      measured.damageXp += d.dealt * t.points
      log(entries, `${t.name} ${kind === 'slay-undead' ? 'обращается в прах' : 'уничтожен силами Хаоса'}.`, 'death')
      break
    }
    case 'nosave':
      t.noSave = true
      log(entries, `${t.name} больше не может выкидывать удачу от заклинаний.`)
      break
    case 'return':
      break
  }
  void spell
}

function buildSummon(effect: Extract<SpellEffect, { type: 'summon' }>, hero: Hero, idx: DataIndex, entries: LogEntry[], combat: CombatState): AllyInstance | null {
  const lvl = L(hero)
  switch (effect.kind) {
    case 'decoy': {
      const rounds = Math.max(1, Math.ceil(lvl / 2))
      const a = makeAlly(hero.uid, effect.name, heroDefense(hero, idx), 'none', 1, rounds, true)
      log(entries, `Появляется ${effect.name}: враги могут атаковать его вместо героев (${rounds} раунд(ов)).`)
      return a
    }
    case 'elemental': {
      let r = k6()
      while (r > 4) r = k6()
      const table = [
        { name: 'Воздушный элементал', defense: 12, attacks: '1к6', lives: 10 },
        { name: 'Водный элементал', defense: 13, attacks: '2к6', lives: 15 },
        { name: 'Земной элементал', defense: 14, attacks: '3к6', lives: 20 },
        { name: 'Огненный элементал', defense: 15, attacks: '4к6', lives: 25 },
      ][r - 1]
      log(entries, `к6 = ${r}: является ${table.name} (защита ${table.defense}, атаки ${table.attacks}, жизни ${table.lives}).`)
      return makeAlly(hero.uid, table.name, table.defense, table.attacks, table.lives)
    }
    case 'demon': {
      const m = idx.monsterById.get('demon')
      const r = k6()
      if (r === 1 && m) {
        const inst = makeMonsterInstance(m, 0)
        inst.name = 'Демон (вышел из-под контроля)'
        combat.monsters.push(inst)
        log(entries, 'к6 = 1: демон выходит из-под контроля и нападает на вас!', 'death')
        return null
      }
      const table = Array.isArray(m?.attacks) ? m!.attacks.join('-') : '2-4-6-8-10-12'
      log(entries, `к6 = ${r}: демон подчиняется и сражается за вас.`)
      return makeAlly(hero.uid, 'Демон', m?.defense ?? 16, table, m?.lives ?? 40)
    }
    default: {
      const lives = summonLives(effect.lives, lvl, hero)
      const a = makeAlly(hero.uid, effect.name, effect.defense ?? 10, effect.attacks ?? '1к6', lives)
      log(entries, `Появляется ${effect.name}: защита ${a.defense}, атаки ${a.attacks}, жизни ${lives}.`)
      return a
    }
  }
}

export function statName(stat: string): string {
  return ({ strength: 'сила', dexterity: 'ловкость', accuracy: 'меткость', luck: 'удача', defense: 'защита', attacks: 'атаки' } as Record<string, string>)[stat] ?? stat
}

export function wardName(kind: string): string {
  return ({
    invulnerable: 'неуязвимость', invisible: 'невидимость', crystal: 'хрустальный щит (монстры до 2 уровня не могут атаковать)',
    antimagic: 'защита от заклинаний', 'air-wall': 'защита от метательного оружия', undead: 'мертвецы не замечают',
    luck: 'следующий бросок удачи удастся', 'infinite-mana': 'мана не убывает',
  } as Record<string, string>)[kind] ?? kind
}

export { isConscious }
