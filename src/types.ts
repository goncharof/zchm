/**
 * Общие типы данных игры «Заклятье Чёрного мага».
 * JSON-файлы в src/data/ должны соответствовать этим интерфейсам.
 */

export type ClassId = 'warrior' | 'barbarian' | 'thief' | 'mage' | 'priest'
export type Caster = 'priest' | 'mage'
/** л = любая рука, п = правая рука, д = двуручное */
export type Hand = 'any' | 'right' | 'two'
export type ExtraAttackKind = 'petrify' | 'freeze' | 'paralysis' | 'poison'
export type StatKey = 'strength' | 'dexterity' | 'accuracy' | 'luck' | 'defense'

/** Строка таблицы уровней класса */
export interface LevelRow {
  level: number
  xp: number
  lives: number
  mana?: number
  /** прибавка характеристики при достижении уровня, напр. { strength: 1 } */
  bonus?: Partial<Record<StatKey, number>>
  /** особое свойство 12-го уровня */
  special?: string
}

export interface CharacterClass {
  id: ClassId
  name: string
  caster?: Caster
  description: string
  /** правила по оружию словами, как в инструкции */
  weaponRule: string
  rangedRule: string
  /** допустимые группы оружия; 'all' = любое */
  allowedWeaponGroups: string[] | 'all'
  forbiddenHands?: Hand[]
  allowedRangedGroups: string[] | 'all' | 'none'
  oneHandOnly?: boolean
  levels: LevelRow[]
}

export interface Weapon {
  id: string
  name: string
  group: 'sword' | 'axe' | 'mace' | 'dagger' | 'other' | 'bow' | 'crossbow' | 'dart' | 'ammo' | 'unarmed'
  price: number
  /** шесть чисел: урон по результату к6 */
  attacks?: number[]
  hand?: Hand
  ranged?: boolean
  throwable?: boolean
  accuracyBonus?: number
  note?: string
}

export interface Armor {
  id: string
  name: string
  price: number
  slot: 'body' | 'shield' | 'helmet' | 'gloves'
  /** абсолютное значение защиты (для доспехов на тело) */
  defense?: number
  /** прибавка к защите (щит, шлем) */
  defenseBonus?: number
  strengthBonus?: number
}

export interface Item {
  id: string
  name: string
  price: number
  description: string
}

export interface Artifact {
  /** номер 1..18 по броску к18 */
  n: number
  id: string
  name: string
  kind: 'melee' | 'ranged' | 'armor' | 'accessory'
  attacks?: number[]
  hand?: Hand
  defense?: number
  defenseBonus?: number
  strengthBonus?: number
  luckBonus?: number
  accuracyBonus?: number
  /** особое свойство словами (стрела раздваивается, всегда попадает...) */
  special?: string
  description: string
}

export type SpellEffect =
  | { type: 'damage'; dice: string; perLevel?: boolean; max?: number; targets: 'one' | 'all' | 'many' }
  | { type: 'heal'; perMana: number }
  | { type: 'restore-all' }
  | { type: 'buff'; stat: 'strength' | 'dexterity' | 'accuracy' | 'luck' | 'defense' | 'attacks'; amount: number | string; scope: 'self' | 'ally' | 'party'; duration: string }
  | { type: 'debuff'; stat: 'defense' | 'attacks' | 'strength'; amount: number | string; scope: 'one' | 'all'; duration: string }
  | { type: 'escape' }
  | { type: 'summon'; name: string; defense?: number; attacks?: string; lives?: string }
  | { type: 'manual' }

export interface Spell {
  id: string
  caster: Caster
  level: number
  name: string
  /** фиксированная стоимость в мане; null, если по формуле */
  cost: number | null
  costFormula?: string
  target?: string
  duration?: string
  /** число, которое противнику нужно выкинуть на к18, чтобы увернуться ("удача от заклинания") */
  luck?: number
  /** фиксированный опыт; null, если по формуле */
  xp: number | null
  xpFormula?: string
  description: string
  effect: SpellEffect
}

export interface Monster {
  id: string
  name: string
  page: number
  level?: number
  attacks?: number[] | 'death' | string
  defense?: number
  courage?: number
  mana?: number
  lives?: number
  /** опыт за каждую отнятую жизнь */
  points?: number
  extraAttacks?: { kind: ExtraAttackKind; threshold: number }[]
  spells?: string[]
  luckSave?: { against: string; threshold: number }
  /** NPC без боевых характеристик (Мерлин, Торговец, Чёрный маг...) */
  special?: boolean
  description: string
  image: string
}

/** Подсказки движку, извлечённые из текста параграфа Книги Жизни */
export interface ParagraphHints {
  /** проверки удачи: число, которое нужно выкинуть */
  luck?: number[]
  /** номера бутылок (1..6), упомянутых в тексте */
  bottles?: number[]
  /** суммы монет, упомянутые в тексте */
  coins?: number[]
  /** id монстров из бестиария, упомянутых в тексте */
  monsters?: string[]
  artifact?: boolean
  /** свитки: уровень и тип заклинания, если указан */
  scrolls?: { caster?: Caster; level?: number }[]
}

export interface Paragraph {
  n: number
  text: string
  hints?: ParagraphHints
}

export interface Location {
  id: string
  name: string
  order: number
  /** путь к плану локации (img/locations/<id>.jpg), если есть */
  plan?: string
  /** страницы Книги Жизни [первая, последняя] */
  pages: [number, number]
  paragraphs: Paragraph[]
}

/** Точка на карте мира (координаты в долях ширины/высоты изображения) */
export interface WorldNode {
  id: string
  name: string
  x: number
  y: number
  /** id локации в Книге Жизни, если это замок/город */
  locationId?: string
}

export interface WorldEdge {
  from: string
  to: string
  /** число клеток (красных крестов) на дороге между узлами */
  cells: number
}

export interface WorldMap {
  image: string
  width: number
  height: number
  nodes: WorldNode[]
  edges: WorldEdge[]
}
