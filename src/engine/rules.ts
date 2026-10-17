/** Константы правил, не зависящие от JSON (дублируют src/data/rules.json для типобезопасности). */
export const START_MONEY = 40
export const BASE_DEFENSE = 9
export const UNCONSCIOUS_AT = 0
export const DEAD_AT = -10
export const REST_COST_PER_DAY = 2
export const REST_LIVES_PER_DAY = 5
export const REST_MANA_PER_DAY = 5
export const XP_TRAP_FOUND = 400
export const XP_ARTIFACT_FOUND = 500
export const MAX_LEVEL = 12

/** Бегство: уровень монстра → число на к18 (стр. 18 Инструкции) */
export function fleeTarget(maxMonsterLevel: number): number {
  if (maxMonsterLevel <= 2) return 10
  if (maxMonsterLevel <= 4) return 11
  if (maxMonsterLevel <= 6) return 12
  if (maxMonsterLevel <= 8) return 13
  if (maxMonsterLevel <= 10) return 14
  return 15
}

import type { ExtraAttackKind } from '@/types'

export interface ExtraAttackRule {
  kind: ExtraAttackKind
  name: string
  /** бросок удачи, чтобы избежать */
  luck: number
  description: string
}

export const EXTRA_ATTACKS: Record<ExtraAttackKind, ExtraAttackRule> = {
  freeze: {
    kind: 'freeze',
    name: 'Оледенение',
    luck: 12,
    description: 'Персонаж превращается в глыбу льда и теряет 1к18 жизней. 1к6 раундов не может двигаться, жизней при этом не теряет.',
  },
  petrify: {
    kind: 'petrify',
    name: 'Окаменение',
    luck: 13,
    description: 'Персонаж превращается в камень до конца боя. Каждый раунд теряет 1к6 жизней.',
  },
  paralysis: {
    kind: 'paralysis',
    name: 'Паралич',
    luck: 11,
    description: 'Парализованный не может двигаться 1к6 раундов. Каждый раунд теряет 1к3 жизней.',
  },
  poison: {
    kind: 'poison',
    name: 'Яд',
    luck: 10,
    description: 'При попадании отнимается 1к6 жизней, затем по 1 жизни за раунд до противоядия или потери сознания.',
  },
}

export interface BottleRule {
  n: number
  label: string
  effect: 'death' | 'dice' | 'restore-all'
  formula?: string
  luck?: number
  good: boolean
}

/** Бутылки (стр. 16 Инструкции) */
export const BOTTLES: BottleRule[] = [
  { n: 1, label: 'смерть (удача 9)', effect: 'death', luck: 9, good: false },
  { n: 2, label: '−1к6 жизней', effect: 'dice', formula: '-1к6', good: false },
  { n: 3, label: '−1к3 жизней', effect: 'dice', formula: '-1к3', good: false },
  { n: 4, label: '+1к3 жизней', effect: 'dice', formula: '+1к3', good: true },
  { n: 5, label: '+1к6 жизней', effect: 'dice', formula: '+1к6', good: true },
  { n: 6, label: 'восстанавливает все жизни', effect: 'restore-all', good: true },
]
