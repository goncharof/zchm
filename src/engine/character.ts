/** Персонаж: создание, производные характеристики, опыт и уровни, жизни. */
import type { CharacterClass, LevelRow, Weapon, Hand, WardKind } from '@/types'
import type { DataIndex } from './data'
import type { Buff, Hero, InventoryEntry, EquipSlot } from './model'
import { uid } from './model'
import { BASE_DEFENSE, DEAD_AT, MAX_LEVEL, START_MONEY, UNCONSCIOUS_AT } from './rules'

export function levelRow(cls: CharacterClass, level: number): LevelRow {
  const row = cls.levels.find((r) => r.level === level)
  if (!row) throw new Error(`Нет строки уровня ${level} для класса ${cls.id}`)
  return row
}

export function createHero(name: string, classId: string, idx: DataIndex): Hero {
  const cls = idx.cls(classId)
  const row0 = levelRow(cls, 0)
  const spellbook = cls.caster
    ? idx.data.spells.filter((s) => s.caster === cls.caster && s.level === 0).map((s) => s.id)
    : []
  return {
    uid: uid('hero'),
    name: name.trim() || cls.name,
    classId: cls.id,
    level: 0,
    xp: 0,
    strength: 0,
    dexterity: 0,
    accuracy: 0,
    luck: 0,
    defenseBonus: 0,
    lives: row0.lives,
    maxLives: row0.lives,
    mana: row0.mana ?? 0,
    maxMana: row0.mana ?? 0,
    money: START_MONEY,
    inventory: [],
    equipment: {},
    spellbook,
    pendingSpellPicks: 0,
    status: {},
    buffs: [],
  }
}

export function entryByUid(hero: Hero, entryUid: string): InventoryEntry | undefined {
  return hero.inventory.find((e) => e.uid === entryUid)
}

export function equippedEntry(hero: Hero, slot: EquipSlot): InventoryEntry | undefined {
  const u = hero.equipment[slot]
  return u ? entryByUid(hero, u) : undefined
}

function buffSum(hero: Hero, stat: string): number {
  return hero.buffs.filter((b) => b.stat === stat).reduce((a, b) => a + b.amount, 0)
}

/** Слоты артефактов по номеру (стр. 24–26 Инструкции) */
export function artifactSlot(n: number): EquipSlot | 'melee' | 'ranged' {
  if (n <= 6) return 'melee'
  if (n <= 9) return 'ranged'
  if (n === 10) return 'shield'
  if (n === 11) return 'helmet'
  if (n <= 14) return 'body'
  return (['bracelet', 'ring', 'amulet', 'necklace'] as const)[n - 15] ?? 'ring'
}

function artifactBonuses(hero: Hero, idx: DataIndex) {
  const out = { defense: 0, strength: 0, luck: 0, accuracy: 0 }
  for (const slot of ['shield', 'helmet', 'bracelet', 'ring', 'amulet', 'necklace'] as EquipSlot[]) {
    const e = equippedEntry(hero, slot)
    if (!e || e.kind !== 'artifact') continue
    const a = idx.artifact(parseInt(e.ref, 10))
    out.defense += a.defenseBonus ?? 0
    out.strength += a.strengthBonus ?? 0
    out.luck += a.luckBonus ?? 0
    out.accuracy += a.accuracyBonus ?? 0
  }
  return out
}

/** Защита = доспех (9 без доспеха) + щит + шлем + артефакты + "з+1" с уровней + баффы */
export function heroDefense(hero: Hero, idx: DataIndex): number {
  let base = BASE_DEFENSE
  const body = equippedEntry(hero, 'body')
  if (body) {
    if (body.kind === 'armor') base = idx.armor(body.ref).defense ?? BASE_DEFENSE
    else if (body.kind === 'artifact') base = idx.artifact(parseInt(body.ref, 10)).defense ?? BASE_DEFENSE
  }
  let bonus = 0
  for (const slot of ['shield', 'helmet'] as EquipSlot[]) {
    const e = equippedEntry(hero, slot)
    if (e?.kind === 'armor') bonus += idx.armor(e.ref).defenseBonus ?? 0
  }
  bonus += artifactBonuses(hero, idx).defense
  return base + bonus + hero.defenseBonus + buffSum(hero, 'defense')
}

export function heroStrength(hero: Hero, idx: DataIndex): number {
  let s = hero.strength + buffSum(hero, 'strength') + artifactBonuses(hero, idx).strength
  const gloves = equippedEntry(hero, 'gloves')
  if (gloves?.kind === 'armor') s += idx.armor(gloves.ref).strengthBonus ?? 0
  return s
}

export function heroDexterity(hero: Hero): number {
  return hero.dexterity + buffSum(hero, 'dexterity')
}

export function heroAccuracy(hero: Hero, idx: DataIndex): number {
  return hero.accuracy + buffSum(hero, 'accuracy') + artifactBonuses(hero, idx).accuracy
}

export function heroLuck(hero: Hero, idx: DataIndex): number {
  return hero.luck + buffSum(hero, 'luck') + artifactBonuses(hero, idx).luck
}

export interface HandWeapon {
  /** слот экипировки или 'spell' для магического оружия из заклинания */
  slot: EquipSlot | 'spell'
  entry?: InventoryEntry
  name: string
  /** таблица атак по к6 (обычное оружие) */
  attacks?: number[]
  /** формула урона (магическое оружие: «1к6+4», «1к18») */
  formula?: string
  ranged: boolean
  hand?: Hand
  accuracyBonus: number
  dexterityBonus?: number
  /** число атак за одно действие (Железные руки — 2) */
  attacksPerRound?: number
  /** отнятые жизни восстанавливают здоровье атакующего (Меч Тьмы) */
  lifesteal?: boolean
  /** особые свойства артефактов */
  alwaysHits?: boolean
  doubleDamage?: boolean
  poisoned?: boolean
  /** лук или арбалет: нужны стрелы */
  needsAmmo?: boolean
  /** стрелы, которые будут выпущены следующим выстрелом */
  ammoEntry?: InventoryEntry
  /** сколько выстрелов/бросков осталось */
  ammoLeft?: number
  /** метательное оружие, которое улетает при броске (дротик, копьё в слоте метательного) */
  thrown?: boolean
}

const BOW_GROUPS = ['bow', 'crossbow']
/** ХАУСРУЛ: эльфийские стрелы расходуются первыми (меткость +3); арбалет стреляет теми же стрелами */
export const AMMO_ORDER = ['elfiyskaya-strela', 'strela']

export function pickAmmo(hero: Hero): InventoryEntry | undefined {
  for (const ref of AMMO_ORDER) {
    const e = hero.inventory.find((x) => x.kind === 'weapon' && x.ref === ref && x.qty > 0)
    if (e) return e
  }
  return undefined
}

export function arrowsLeft(hero: Hero): number {
  return hero.inventory.filter((x) => x.kind === 'weapon' && AMMO_ORDER.includes(x.ref)).reduce((a, x) => a + x.qty, 0)
}

export function attacksLabel(w: HandWeapon): string {
  return w.attacks ? w.attacks.join('-') : (w.formula ?? '')
}

/** «Молитва»: +3 к ближайшему броску кубика героя (атака, бегство, удача); снимается при использовании */
export function consumePrayer(hero: Hero): number {
  const b = hero.buffs.find((x) => x.stat === 'ward' && x.ward === 'prayer')
  if (!b) return 0
  hero.buffs = hero.buffs.filter((x) => x !== b)
  return 3
}

/** Активная защитная аура нужного вида */
export function hasWard(hero: Hero, kind: WardKind): Buff | undefined {
  return hero.buffs.find((b) => b.stat === 'ward' && b.ward === kind)
}

/** Оружие в руках и метательное оружие с таблицами атак */
export function heroWeapons(hero: Hero, idx: DataIndex): HandWeapon[] {
  const out: HandWeapon[] = []
  for (const slot of ['rightHand', 'leftHand', 'ranged'] as EquipSlot[]) {
    const e = equippedEntry(hero, slot)
    if (!e) continue
    if (e.kind === 'weapon') {
      const w = idx.weapon(e.ref)
      if (!w.attacks) continue
      const thrown = w.group === 'dart' || (slot === 'ranged' && !!w.throwable)
      const needsAmmo = BOW_GROUPS.includes(w.group)
      const ammo = needsAmmo ? pickAmmo(hero) : undefined
      const ammoBonus = ammo ? idx.weapon(ammo.ref).accuracyBonus ?? 0 : 0
      out.push({
        slot, entry: e, name: w.name, attacks: w.attacks, ranged: !!w.ranged || thrown, hand: w.hand,
        accuracyBonus: (w.accuracyBonus ?? 0) + ammoBonus, poisoned: e.poisoned,
        needsAmmo, ammoEntry: ammo, thrown, ammoLeft: needsAmmo ? arrowsLeft(hero) : thrown ? e.qty : undefined,
      })
    } else if (e.kind === 'artifact') {
      const a = idx.artifact(parseInt(e.ref, 10))
      if (!a.attacks) continue
      const special = (a.special ?? '').toLowerCase()
      const bow = a.kind === 'ranged'
      const ammo = bow ? pickAmmo(hero) : undefined
      const ammoBonus = ammo ? idx.weapon(ammo.ref).accuracyBonus ?? 0 : 0
      out.push({
        slot, entry: e, name: a.name, attacks: a.attacks, ranged: bow, hand: a.hand, accuracyBonus: (a.accuracyBonus ?? 0) + ammoBonus,
        needsAmmo: bow, ammoEntry: ammo, ammoLeft: bow ? arrowsLeft(hero) : undefined,
        alwaysHits: /всегда попадает/.test(special),
        doubleDamage: /раздваива/.test(special),
        poisoned: e.poisoned,
      })
    }
  }
  for (const b of hero.buffs) {
    if (b.stat === 'weapon' && b.weapon) {
      out.push({ slot: 'spell', name: b.weapon.name, formula: b.weapon.attacks, ranged: false, accuracyBonus: 0, dexterityBonus: b.weapon.dexterityBonus, attacksPerRound: b.weapon.attacksPerRound, lifesteal: b.weapon.lifesteal })
    }
  }
  return out
}

/** Атака без оружия (стр. 20): 1-1-1-2-2-2 */
export const UNARMED: number[] = [1, 1, 1, 2, 2, 2]

export function canUseWeapon(cls: CharacterClass, w: Weapon): boolean {
  if (w.group === 'ammo') return true
  if (w.ranged) {
    if (cls.allowedRangedGroups === 'none') return false
    if (cls.allowedRangedGroups !== 'all' && !cls.allowedRangedGroups.includes(w.group)) return false
    return true
  }
  if (cls.allowedWeaponGroups !== 'all' && !cls.allowedWeaponGroups.includes(w.group)) return false
  if (w.hand && cls.forbiddenHands?.includes(w.hand)) return false
  if (cls.oneHandOnly && w.hand === 'two') return false
  return true
}

export function nextLevelRow(cls: CharacterClass, hero: Hero): LevelRow | null {
  if (hero.level >= MAX_LEVEL) return null
  return levelRow(cls, hero.level + 1)
}

export interface LevelUp {
  heroUid: string
  level: number
  livesGained: number
  manaGained: number
  bonus?: LevelRow['bonus']
  special?: string
  spellPick: boolean
}

/** Начисляет опыт и поднимает уровни, пока хватает очков. */
export function gainXp(hero: Hero, amount: number, idx: DataIndex): LevelUp[] {
  if (amount <= 0) return []
  hero.xp += Math.round(amount)
  const cls = idx.cls(hero.classId)
  const ups: LevelUp[] = []
  for (;;) {
    const next = nextLevelRow(cls, hero)
    if (!next || hero.xp < next.xp) break
    const prev = levelRow(cls, hero.level)
    hero.level = next.level
    const livesGained = next.lives - prev.lives
    const manaGained = (next.mana ?? 0) - (prev.mana ?? 0)
    hero.maxLives = next.lives
    hero.lives = Math.min(hero.maxLives, hero.lives + livesGained)
    hero.maxMana = next.mana ?? 0
    hero.mana = Math.min(hero.maxMana, hero.mana + manaGained)
    if (next.bonus) {
      hero.strength += next.bonus.strength ?? 0
      hero.dexterity += next.bonus.dexterity ?? 0
      hero.accuracy += next.bonus.accuracy ?? 0
      hero.luck += next.bonus.luck ?? 0
      hero.defenseBonus += next.bonus.defense ?? 0
    }
    // ХАУСРУЛ: кастер выбирает одно новое заклинание уровня не выше нового
    const spellPick = !!cls.caster
    if (spellPick) hero.pendingSpellPicks += 1
    ups.push({ heroUid: hero.uid, level: hero.level, livesGained, manaGained, bonus: next.bonus, special: next.special, spellPick })
  }
  return ups
}

/** Изменяет жизни с учётом порогов 0 (без сознания) и −10 (смерть). Возвращает фактическое изменение. */
export function changeLives(hero: Hero, delta: number): number {
  if (hero.status.dead) return 0
  const before = hero.lives
  hero.lives = Math.max(DEAD_AT, Math.min(hero.maxLives, hero.lives + delta))
  if (hero.lives <= DEAD_AT) {
    hero.status.dead = true
    hero.status.unconscious = true
  } else if (hero.lives <= UNCONSCIOUS_AT) {
    hero.status.unconscious = true
  } else {
    hero.status.unconscious = false
  }
  return hero.lives - before
}

export function isActive(hero: Hero): boolean {
  return !hero.status.dead && !hero.status.unconscious && !hero.status.petrified && !(hero.status.paralysis && hero.status.paralysis > 0) && !(hero.status.freeze && hero.status.freeze > 0) && !hero.status.charmed
}

export function isConscious(hero: Hero): boolean {
  return !hero.status.dead && !hero.status.unconscious
}

/** Отдых в трактире: сутки = 2 монеты, +5 жизней, +5 маны (стр. 16) */
export function rest(hero: Hero, days: number, costPerDay: number, lives: number, mana: number): { paid: number; days: number } {
  const affordable = Math.min(days, Math.floor(hero.money / costPerDay))
  if (affordable <= 0) return { paid: 0, days: 0 }
  hero.money -= affordable * costPerDay
  if (!hero.status.dead) {
    hero.lives = Math.min(hero.maxLives, Math.max(hero.lives, 0) + lives * affordable)
    hero.mana = Math.min(hero.maxMana, hero.mana + mana * affordable)
    if (hero.lives > 0) hero.status.unconscious = false
  }
  return { paid: affordable * costPerDay, days: affordable }
}
