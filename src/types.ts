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

export type ControlKind =
  | 'sleep'        // спит N раундов, беззащитен
  | 'paralysis'    // 1к6 раундов, −1к3 жизней за раунд
  | 'petrify'      // до конца боя, −1к6 за раунд
  | 'freeze'       // −1к18 жизней и 1к6 раундов без действий
  | 'web'          // теряет половину жизней
  | 'fear'         // слабые бегут, у сильных атаки −2
  | 'hold'         // удержан: защита −2, атаки вдвое
  | 'choke'        // защита −4, атаки вдвое, −1к3 за раунд
  | 'charm'        // переходит на сторону героев
  | 'slay'         // гибнет, если уровень не выше maxLevel
  | 'slay-undead'  // мертвец обращается в прах
  | 'nosave'       // не может выкинуть удачу от заклинаний
  | 'return'       // сбежавший монстр возвращается в бой
  | 'curse'        // «Несчастье»: монстр бросает кубики дважды и берёт меньшее

export type WardKind =
  | 'invulnerable' // атаки не вредят
  | 'invisible'    // монстры не атакуют
  | 'crystal'      // монстры до 2 уровня не могут атаковать
  | 'antimagic'    // Огненный щит: блокирует заклинания монстров, направленные на этого героя
  | 'spell-shield' // Воздушный щит: общий на партию запас 2к6 уровней заклинаний, отражает особые атаки
  | 'air-wall'     // защита от метательного оружия
  | 'undead'       // мертвецы не замечают
  | 'luck'         // следующий бросок удачи успешен
  | 'infinite-mana'// мана не убывает
  | 'prayer'       // «Молитва»: +3 к следующему броску кубика
  | 'reflect'      // «Отражение магии»: следующее заклинание монстра (уровня не выше мага) бьёт по нему самому

export type SpellEffect =
  | { type: 'damage'; dice: string; perLevel?: boolean; max?: number; targets: 'one' | 'all' | 'many'; slayBelow?: number }
  | { type: 'heal'; perMana: number }
  | { type: 'restore-all' }
  | { type: 'buff'; stat: 'strength' | 'dexterity' | 'accuracy' | 'luck' | 'defense' | 'attacks'; amount: number | string; scope: 'self' | 'ally' | 'party'; duration: string }
  | { type: 'debuff'; stat: 'defense' | 'attacks' | 'strength'; amount: number | string; scope: 'one' | 'all'; duration: string }
  | { type: 'escape' }
  | { type: 'summon'; name: string; defense?: number; attacks?: string; lives?: string; kind?: 'creature' | 'decoy' | 'elemental' | 'demon' | 'copy' | 'zombie' }
  | { type: 'duplicate-bottle' }
  | { type: 'control'; kind: ControlKind; targets: 'one' | 'all'; maxLevel?: number; duration?: string }
  | { type: 'weapon'; name: string; attacks: string; dexterityBonus?: number; attacksPerRound?: number; lifesteal?: boolean; duration: string }
  | { type: 'ward'; kind: WardKind; scope: 'self' | 'ally' | 'party'; duration: string }
  | { type: 'initiative' }
  | { type: 'extra-action' }
  | { type: 'create-bottle' }
  | { type: 'identify' }
  | { type: 'drain-mana'; ratio: number }
  | { type: 'restore-mana'; ratio: number }
  | { type: 'cure' }
  | { type: 'resurrect' }
  | { type: 'empower' }
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
  /** шесть чисел по к6; 'death' — смертельная атака; 'magic' — бьёт только магией; 'none' — не атакует */
  attacks?: number[] | 'death' | 'magic' | 'none'
  defense?: number
  courage?: number
  mana?: number
  lives?: number
  /** опыт за каждую отнятую жизнь */
  points?: number
  extraAttacks?: { kind: ExtraAttackKind; threshold: number }[]
  /** «Атакует дважды/трижды» — атак за раунд */
  attacksPerRound?: number
  /** «Уничтожение оружия (кроме магического) — N»: при броске к18 ≥ N разъедает оружие в руках */
  destroysWeapon?: number
  spells?: string[]
  luckSave?: { against: string; threshold: number }
  /** NPC без боевых характеристик (Мерлин, Торговец, Чёрный маг...) */
  special?: boolean
  /** многоголовые: число голов и жизни на голову (lives = heads × livesPerHead) */
  heads?: number
  livesPerHead?: number
  /** отрубленные головы отрастают (Гидра): в бою каждая голова — отдельный противник */
  regrows?: boolean
  description: string
  image: string
}

/** Подсказки движку, извлечённые из текста параграфа Книги Жизни */
export interface ParagraphHints {
  /** проверки удачи: число, которое нужно выкинуть */
  luck?: number[]
  /** номера бутылок (1..6), упомянутых в тексте */
  bottles?: number[]
  /** суммы монет, которые можно получить (находки, награды) */
  coins?: number[]
  /** суммы, которые нужно заплатить (цены, поборы, ставки) */
  prices?: number[]
  /** id монстров из бестиария, упомянутых в тексте */
  monsters?: string[]
  /** число монстров по тексту («5 пьяных орков»), если больше одного */
  monsterCounts?: Record<string, number>
  artifact?: boolean
  /** в тексте есть таверна/трактир — можно отдохнуть */
  tavern?: boolean
  /** в тексте есть лавка или торговец */
  shop?: boolean
  /** свитки: уровень и тип заклинания, если указан */
  scrolls?: { caster?: Caster; level?: number }[]
}

export interface RollOption {
  /** результаты кубика, при которых срабатывает вариант */
  values: number[]
  text: string
  hints?: ParagraphHints
}

/** repeat — список бросают много раз («перед каждым черепом», «в каждом из шести домов»); иначе — один бросок */
export type SegmentBlock = { text: string } | { roll: RollOption[]; repeat?: boolean }

/** Часть параграфа: сцена (видна сразу) или ветка решения (исход раскрывается по выбору) */
export interface ParagraphSegment {
  kind: 'scene' | 'branch'
  /** условие ветки: «Если вы его освобождаете» */
  label?: string
  blocks: SegmentBlock[]
  hints?: ParagraphHints
  /** ветка-исход: после победы или поражения в бою, после удачной или проваленной проверки удачи */
  when?: 'win' | 'lose' | 'luckOk' | 'luckFail'
}

export interface Paragraph {
  n: number
  /** полный текст — только у параграфов без разметки; у размеченных собирается из segments (src/game/book.ts) */
  text?: string
  hints?: ParagraphHints
  /** разбиение на сцену и ветки (tools/segment.py); нет — параграф без выборов */
  segments?: ParagraphSegment[]
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
