/** Заклинания: стоимость, применение эффектов, опыт. */
import type { Spell, SpellEffect } from '@/types'
import type { DataIndex } from './data'
import type { CombatState, Hero, LogEntry, MonsterInstance } from './model'
import { changeLives, gainXp, heroDefense, type LevelUp } from './character'
import { k18, rollFormula } from './dice'
import { damageMonster } from './combat'

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

/** Стоимость в мане: число или формула из текста */
export function resolveCost(spell: Spell, hero: Hero, param?: number): number {
  if (spell.cost !== null && spell.cost !== undefined) return spell.cost
  const f = (spell.costFormula ?? '').toLowerCase()
  if (/за 2 уровня/.test(f)) return Math.ceil(L(hero) / 2)
  if (/за (1 )?уровень/.test(f)) return L(hero)
  if (/за 1 стрел/.test(f)) return Math.min(3, Math.max(1, param ?? 1))
  if (/за 3 ман/.test(f)) return Math.max(1, param ?? 1)
  return Math.max(0, param ?? 0)
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

function durationRounds(duration: string | undefined, hero: Hero): number {
  const d = (duration ?? '').toLowerCase()
  if (!d) return -1
  if (/бой/.test(d)) return -1
  if (/за 2 уровня/.test(d)) return Math.ceil(L(hero) / 2)
  if (/за (1 )?уровень/.test(d)) return L(hero)
  const m = d.match(/(\d+)\s*раунд/)
  if (m) return parseInt(m[1], 10)
  if (/1к6 раунд/.test(d)) return rollFormula('1к6').total
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
    // призрачный доспех даёт абсолютную защиту; переводим в прибавку к текущей
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
 * "половина жизней" — половина текущих жизней цели (передаётся через targetLives).
 */
export function rollSpellDamage(effect: Extract<SpellEffect, { type: 'damage' }>, hero: Hero, targetLives = 0): { total: number; detail: string } {
  const raw = effect.dice.trim().toLowerCase()
  if (/половин/.test(raw)) {
    const half = Math.ceil(Math.max(0, targetLives) / 2)
    return { total: half, detail: 'половина жизней' }
  }
  const per = raw.match(/^(\S+)\s+за\s+(\d+)\s+уров/)
  const dice = (per ? per[1] : raw).replace(/\s+/g, '')
  const divisor = per ? parseInt(per[2], 10) : 1
  const times = per ? Math.max(1, Math.floor(L(hero) / divisor)) : effect.perLevel ? L(hero) : 1
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

/** Применить заклинание. Мутирует героя, цели и состояние боя. */
export function castSpell(input: CastInput): CastResult {
  const { hero, spell, idx, heroes, combat } = input
  const entries: LogEntry[] = []
  const res: CastResult = { ok: false, log: entries, manaSpent: 0, xp: 0, damage: 0, levelUps: [] }
  const why = canCast(hero, spell, idx, input.param)
  if (why) {
    log(entries, `${hero.name}: ${why}`, 'info')
    return res
  }
  const cost = resolveCost(spell, hero, input.param)
  const effect = spell.effect ?? { type: 'manual' }
  const measured = { damageXp: 0, healed: 0, manaMoved: 0 }
  const aliveMonsters = () => (combat?.monsters ?? []).filter((m) => !m.dead && !m.fled)

  switch (effect.type) {
    case 'damage': {
      if (!combat) { log(entries, 'Боевое заклинание применяется только в бою', 'info'); return res }
      let targets: MonsterInstance[] = []
      if (effect.targets === 'one') {
        const t = aliveMonsters().find((m) => m.uid === input.targetUid)
        if (!t) { log(entries, 'Нужно выбрать цель', 'info'); return res }
        targets = [t]
      } else {
        targets = aliveMonsters().slice(0, effect.targets === 'many' ? 10 : undefined)
      }
      hero.mana -= cost
      res.manaSpent = cost
      log(entries, `${hero.name} произносит «${spell.name}» (−${cost} маны).`)
      const volleys = /за 1 стрел/.test(spell.costFormula ?? '') ? Math.min(3, Math.max(1, input.param ?? 1)) : 1
      for (const t of targets) {
        for (let v = 0; v < volleys; v++) {
          let dodged = false
          let half = false
          if (spell.luck) {
            const r = k18()
            if (r >= spell.luck) {
              if (/magicheskiy-shar/.test(spell.id)) half = true
              else dodged = true
              log(entries, `${t.name} бросает удачу от заклинания: ${r} ≥ ${spell.luck} — ${half ? 'урон вдвое меньше' : 'увернулся'}.`, 'luck')
            } else {
              log(entries, `${t.name} бросает удачу от заклинания: ${r} < ${spell.luck} — не увернулся.`, 'luck')
            }
          }
          if (dodged) continue
          const dmg = rollSpellDamage(effect, hero, t.lives)
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
      const target = heroes.find((h) => h.uid === (input.targetHeroUid ?? hero.uid)) ?? hero
      const manaPerLife = Math.round(1 / effect.perMana)
      const want = Math.max(1, input.param ?? 1)
      const missing = Math.max(0, target.maxLives - target.lives)
      const spend = Math.min(want, hero.mana, missing * manaPerLife) - (Math.min(want, hero.mana, missing * manaPerLife) % manaPerLife)
      if (spend <= 0) { log(entries, `${target.name} не нуждается в лечении`, 'info'); return res }
      hero.mana -= spend
      res.manaSpent = spend
      const healed = changeLives(target, Math.floor(spend * effect.perMana))
      measured.healed = healed
      log(entries, `${hero.name} лечит ${target.name}: +${healed} жизней за ${spend} маны.`)
      break
    }
    case 'restore-all': {
      const target = heroes.find((h) => h.uid === (input.targetHeroUid ?? hero.uid)) ?? hero
      hero.mana -= cost
      res.manaSpent = cost
      const healed = changeLives(target, target.maxLives - target.lives)
      measured.healed = healed
      log(entries, `${hero.name} произносит «${spell.name}»: ${target.name} восстанавливает все жизни (+${healed}).`)
      break
    }
    case 'buff': {
      hero.mana -= cost
      res.manaSpent = cost
      const { value, multiplier } = parseAmount(effect.amount, hero, effect.stat, effect.stat === 'defense' ? heroDefense(hero, idx) : undefined)
      const rounds = durationRounds(effect.duration ?? spell.duration, hero)
      let targets: Hero[]
      if (effect.scope === 'party') targets = heroes.filter((h) => !h.status.dead)
      else if (effect.scope === 'ally') targets = [heroes.find((h) => h.uid === (input.targetHeroUid ?? hero.uid)) ?? hero]
      else targets = [hero]
      for (const t of targets) t.buffs.push({ source: spell.name, stat: effect.stat, amount: value, multiplier, rounds })
      log(entries, `${hero.name} произносит «${spell.name}»: ${targets.map((t) => t.name).join(', ')} — ${statName(effect.stat)} ${multiplier ? `×${value}` : (value >= 0 ? '+' : '') + value}${rounds > 0 ? ` на ${rounds} раунд(ов)` : ' до конца боя'}.`)
      break
    }
    case 'debuff': {
      if (!combat) { log(entries, 'Применяется только в бою', 'info'); return res }
      hero.mana -= cost
      res.manaSpent = cost
      const { value, multiplier } = parseAmount(effect.amount, hero, effect.stat)
      const targets = effect.scope === 'one' ? aliveMonsters().filter((m) => m.uid === input.targetUid) : aliveMonsters()
      if (!targets.length) { log(entries, 'Нет цели', 'info'); hero.mana += cost; res.manaSpent = 0; return res }
      for (const t of targets) {
        if (effect.stat === 'defense') t.defenseMod += value
        else if (multiplier) t.attackMultiplier *= value
        else t.attackMod += value
      }
      log(entries, `${hero.name} произносит «${spell.name}»: ${targets.map((t) => t.name).join(', ')} — ${statName(effect.stat)} ${multiplier ? `×${value}` : (value >= 0 ? '+' : '') + value}.`)
      break
    }
    case 'escape': {
      hero.mana -= cost
      res.manaSpent = cost
      log(entries, `${hero.name} произносит «${spell.name}» — враги теряют вас из виду, команда беспрепятственно уходит.`, 'flee')
      res.escaped = true
      if (combat) combat.finished = 'fled'
      break
    }
    case 'summon': {
      hero.mana -= cost
      res.manaSpent = cost
      log(entries, `${hero.name} призывает: ${effect.name}${effect.defense ? ` (защита ${effect.defense}` : ''}${effect.attacks ? `, атаки ${effect.attacks}` : ''}${effect.lives ? `, жизни ${effect.lives}` : ''}${effect.defense ? ')' : ''}. Существо отыгрывается вручную.`)
      break
    }
    default: {
      hero.mana -= cost
      res.manaSpent = cost
      log(entries, `${hero.name} произносит «${spell.name}» (−${cost} маны). Эффект по описанию: ${spell.description}`)
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

export function statName(stat: string): string {
  return ({ strength: 'сила', dexterity: 'ловкость', accuracy: 'меткость', luck: 'удача', defense: 'защита', attacks: 'атаки' } as Record<string, string>)[stat] ?? stat
}
