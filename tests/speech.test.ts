// Озвучка ведущего: подготовка текста к чтению вслух.
import { describe, expect, it } from 'vitest'
import { speechChunks, speechSupported } from '@/ui/speech'

describe('озвучка', () => {
  it('убирает эмодзи, читает § как «параграф» и режет длинный текст по предложениям', () => {
    expect(speechChunks('⚔ Бой! См. § 12.')).toEqual(['Бой! См. параграф 12.'])
    const long = Array.from({ length: 12 }, (_, i) => `Предложение номер ${i + 1} о тёмном коридоре и факелах.`).join(' ')
    const parts = speechChunks(long, 120)
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(120)
    expect(parts.join(' ')).toBe(long)
  })

  it('очень длинное предложение без точек тоже режется', () => {
    const run = 'слово '.repeat(100).trim()
    const parts = speechChunks(run, 100)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100)
    expect(parts.join(' ')).toBe(run)
  })

  it('без синтеза речи (сервер, тесты) просто недоступна', () => {
    expect(speechSupported()).toBe(false)
    expect(speechChunks('   ')).toEqual([])
  })
})
