import type { EquipSlot } from '@/engine/model'

export const SLOT_NAMES: Record<EquipSlot, string> = {
  rightHand: 'правая рука',
  leftHand: 'левая рука',
  ranged: 'метательное',
  body: 'доспех',
  shield: 'щит',
  helmet: 'шлем',
  gloves: 'рукавицы',
  accessory1: 'украшение',
  accessory2: 'украшение 2',
}

export const HAND_NAMES: Record<string, string> = { any: 'любая рука', right: 'правая рука', two: 'двуручное' }

export function attacksStr(t?: number[] | string | null): string {
  if (!t) return '—'
  if (Array.isArray(t)) return t.join('-')
  return t === 'death' ? 'смерть' : t
}

export function casterName(c: string): string {
  return c === 'mage' ? 'маг' : 'жрец'
}

export function pct(cur: number, max: number): string {
  if (max <= 0) return '0%'
  return `${Math.max(0, Math.min(100, Math.round((cur / max) * 100)))}%`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
