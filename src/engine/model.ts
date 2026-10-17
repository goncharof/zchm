/**
 * Модель состояния партии. Всё сериализуемо в JSON (сохранения в localStorage / файл).
 */
import type { ClassId, ExtraAttackKind, WardKind } from '@/types'

export type InventoryKind = 'weapon' | 'armor' | 'item' | 'artifact' | 'bottle' | 'scroll'

export interface InventoryEntry {
  /** уникальный id экземпляра */
  uid: string
  kind: InventoryKind
  /** id из weapons/armor/items; для артефакта — номер 1..18 строкой; для свитка — id заклинания; для бутылки — номер 1..6 */
  ref: string
  qty: number
  /** бутылка/свиток опознаны */
  identified?: boolean
  /** оружие смазано ядом (действует на первое попадание) */
  poisoned?: boolean
}

export type EquipSlot = 'rightHand' | 'leftHand' | 'ranged' | 'body' | 'shield' | 'helmet' | 'gloves' | 'accessory1' | 'accessory2'

export interface HeroStatus {
  /** раундов паралича/оледенения осталось */
  paralysis?: number
  freeze?: number
  petrified?: boolean
  /** раундов отравления оружием осталось; -1 = яд монстра (до противоядия) */
  poison?: number
  unconscious?: boolean
  dead?: boolean
  /** заклинание «Инициатива»: в ближайшем бою герои атакуют первыми */
  initiative?: boolean
}

export interface Hero {
  uid: string
  name: string
  classId: ClassId
  level: number
  xp: number
  strength: number
  dexterity: number
  accuracy: number
  luck: number
  /** прибавки к защите от уровней ("з+1") */
  defenseBonus: number
  lives: number
  maxLives: number
  mana: number
  maxMana: number
  money: number
  inventory: InventoryEntry[]
  equipment: Partial<Record<EquipSlot, string>>
  spellbook: string[]
  /** сколько заклинаний можно выбрать после перехода на уровень (ХАУСРУЛ) */
  pendingSpellPicks: number
  status: HeroStatus
  /** временные эффекты заклинаний на текущий бой */
  buffs: Buff[]
}

export interface Buff {
  source: string
  stat: 'strength' | 'dexterity' | 'accuracy' | 'luck' | 'defense' | 'attacks' | 'ward' | 'weapon'
  amount: number
  /** amount — множитель (x2), а не прибавка */
  multiplier?: boolean
  /** раундов осталось; -1 = до конца боя */
  rounds: number
  /** для stat = 'ward' */
  ward?: WardKind
  /** заряд (антимагия: суммарные уровни заклинаний) */
  charge?: number
  /** для stat = 'weapon': временное магическое оружие */
  weapon?: { name: string; attacks: string; dexterityBonus?: number; attacksPerRound?: number; lifesteal?: boolean }
}

/** Спутник (неигровой персонаж, стр. 16 Инструкции): сражается за партию оговорённое число боёв */
export interface Companion {
  uid: string
  monsterId: string
  name: string
  lives: number
  maxLives: number
  battlesLeft: number
}

/** Призванное существо или иллюзия на стороне героев */
export interface AllyInstance {
  uid: string
  ownerUid: string
  /** союзник — спутник партии (после боя его жизни и счётчик боёв сохраняются) */
  companionUid?: string
  name: string
  defense: number
  /** формула урона ("1к18", "2к6+2") или 'none' для иллюзий */
  attacks: string
  lives: number
  maxLives: number
  /** раундов осталось; -1 = до конца боя */
  rounds: number
  decoy?: boolean
  dead?: boolean
  attackMultiplier: number
}

export interface MonsterInstance {
  uid: string
  /** головы одного многоголового чудовища (Гидра) */
  groupId?: string
  monsterId: string
  name: string
  level: number
  lives: number
  maxLives: number
  defense: number
  attacks: number[] | 'death' | 'magic' | 'none'
  courage: number | null
  points: number
  extraAttacks?: { kind: ExtraAttackKind; threshold: number }[]
  mana?: number
  spells?: string[]
  /** проверка храбрости уже делалась */
  courageChecked: boolean
  fled: boolean
  dead: boolean
  /** раундов паралича/сна/оледенения */
  disabled?: number
  disabledKind?: 'sleep' | 'paralysis' | 'freeze'
  petrified?: boolean
  /** временные модификаторы от заклинаний */
  defenseMod: number
  attackMod: number
  attackMultiplier: number
  /** раундов отравления оружием (по 1к6 за раунд) */
  poison?: number
  /** удержан «Рукой»: защита −2, атаки вдвое до конца боя */
  held?: boolean
  /** раундов удушья: −1к3 за раунд */
  choke?: number
  /** не может выкинуть удачу от заклинаний */
  noSave?: boolean
  /** атаки −2 от устрашения и т.п. учитываются в attackMod */
  sleeping?: boolean
}

export interface LogEntry {
  t: number
  text: string
  kind?: 'hit' | 'miss' | 'damage' | 'spell' | 'info' | 'xp' | 'death' | 'flee' | 'luck'
}

export interface CombatState {
  round: number
  /** первый раунд — дистанция (метательное оружие и заклинания), затем ближний бой */
  phase: 'ranged' | 'melee'
  turn: 'heroes' | 'monsters'
  monsters: MonsterInstance[]
  /** призванные существа и иллюзии */
  allies: AllyInstance[]
  /** uid героев, уже сходивших в этом раунде */
  acted: string[]
  /** дополнительные действия героев в этом раунде (воин 12 ур., «Замедление времени») */
  extraActions: Record<string, number>
  /** uid героев, сбежавших с поля боя */
  escaped: string[]
  /** что можно подобрать после победы: heroUid → id оружия → количество (дротики, копья, попавшие стрелы) */
  recover: Record<string, Record<string, number>>
  initiative?: { heroes: number; monsters: number }
  /** откуда начался бой — чтобы вернуться */
  returnTo?: string
  finished?: 'victory' | 'fled' | 'defeat'
  /** опыт, начисленный за бой (для сводки) */
  xpEarned: Record<string, number>
}

export interface GameState {
  version: number
  createdAt: number
  updatedAt: number
  heroes: Hero[]
  /** текущий узел карты мира */
  worldNodeId: string | null
  /** текущая локация Книги Жизни (если партия внутри) */
  locationId: string | null
  /** посещённые параграфы: locationId -> номера */
  visited: Record<string, number[]>
  /** игровой день */
  day: number
  gmMode: boolean
  combat: CombatState | null
  log: LogEntry[]
  /** найденные артефакты (номера), чтобы не выпадали повторно */
  artifactsFound: number[]
  /** случайные встречи на дороге, ожидающие прочтения (номера параграфов главы «Дорога») */
  pendingRoad: number[]
  /** выбранный стартовый узел карты */
  startNodeId: string
  /** спутники партии */
  companions: Companion[]
  /** партия победила Чёрного мага */
  victory?: { day: number; heroUid: string; heroName: string }
  seed?: number
}

export const SAVE_VERSION = 1

let counter = 0
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}
