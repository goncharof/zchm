/**
 * Кубики. В игре два кубика: к6 и к18 (в оригинале к18 собирается из к6 + к12 с наклейками
 * или к20 с перебросом 19–20). Генератор подменяемый — для тестов и воспроизводимости.
 */
export type Rng = () => number

let rng: Rng = Math.random

export function setRng(next: Rng): void {
  rng = next
}

/** Детерминированный генератор (mulberry32) для тестов и сидированных партий */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function roll(sides: number): number {
  return Math.floor(rng() * sides) + 1
}

export const k6 = (): number => roll(6)
export const k18 = (): number => roll(18)
export const k3 = (): number => roll(3)

export interface DiceResult {
  total: number
  rolls: number[]
  formula: string
}

/**
 * Разбирает формулы вида "1к6", "3к18", "2к6+2", "1k3", "1к18-2", "3к6+8".
 * Поддерживает и латинскую k, и кириллическую к.
 */
export function rollFormula(formula: string): DiceResult {
  const m = formula.replace(/\s+/g, '').toLowerCase().match(/^(\d*)[kк](\d+)([+-]\d+)?$/)
  if (!m) throw new Error(`Неизвестная формула кубиков: ${formula}`)
  const count = m[1] ? parseInt(m[1], 10) : 1
  const sides = parseInt(m[2], 10)
  // формулу может прислать игрок: «999999999к6» не должен вешать сервер
  if (count < 1 || count > 100 || sides < 1 || sides > 1000) throw new Error(`Слишком большая формула кубиков: ${formula}`)
  const mod = m[3] ? parseInt(m[3], 10) : 0
  const rolls: number[] = []
  for (let i = 0; i < count; i++) rolls.push(roll(sides))
  return { total: rolls.reduce((a, b) => a + b, 0) + mod, rolls, formula }
}

/** Таблица атак: шесть чисел, индекс = результат к6 − 1 */
export function rollAttackTable(table: number[]): { roll: number; damage: number } {
  const r = k6()
  return { roll: r, damage: table[Math.min(r, table.length) - 1] ?? 0 }
}
