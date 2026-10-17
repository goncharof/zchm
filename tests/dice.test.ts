import { describe, expect, it, beforeEach } from 'vitest'
import { k18, k6, rollFormula, seededRng, setRng, rollAttackTable } from '@/engine/dice'

describe('dice', () => {
  beforeEach(() => setRng(seededRng(42)))
  it('к6 и к18 в диапазоне', () => {
    for (let i = 0; i < 500; i++) {
      const a = k6(); const b = k18()
      expect(a).toBeGreaterThanOrEqual(1); expect(a).toBeLessThanOrEqual(6)
      expect(b).toBeGreaterThanOrEqual(1); expect(b).toBeLessThanOrEqual(18)
    }
  })
  it('формулы с кириллицей и латиницей', () => {
    const r = rollFormula('3к6+8')
    expect(r.rolls).toHaveLength(3)
    expect(r.total).toBe(r.rolls.reduce((a, b) => a + b, 0) + 8)
    expect(rollFormula('1k18').total).toBeLessThanOrEqual(18)
    expect(() => rollFormula('abc')).toThrow()
  })
  it('таблица атак по к6', () => {
    const t = [4, 5, 6, 7, 8, 9]
    for (let i = 0; i < 50; i++) {
      const a = rollAttackTable(t)
      expect(a.damage).toBe(t[a.roll - 1])
    }
  })
  it('сидированный генератор воспроизводим', () => {
    setRng(seededRng(7)); const a = [k18(), k18(), k18()]
    setRng(seededRng(7)); const b = [k18(), k18(), k18()]
    expect(a).toEqual(b)
  })
})
