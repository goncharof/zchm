// @vitest-environment jsdom
// Недавние комнаты: браузер помнит несколько входов, чтобы вернуться за стол без кода.
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetRoom, recentRooms, rememberRoom } from '@/net/client'
import { savedTime } from '@/ui/format'

beforeEach(() => localStorage.clear())

describe('недавние комнаты', () => {
  it('новый вход сверху, повторный обновляет токен и сведения, список не длиннее шести', () => {
    rememberRoom({ code: 'AAA111', token: 't1', name: 'Иван' })
    rememberRoom({ code: 'BBB222', token: 't2', name: 'Иван' })
    rememberRoom({ code: 'AAA111', token: 't3', name: 'Иван' }, { heroes: 'Конан', host: true, day: 4 })
    const list = recentRooms()
    expect(list.map((r) => r.code)).toEqual(['AAA111', 'BBB222'])
    expect(list[0]).toMatchObject({ token: 't3', heroes: 'Конан', host: true, day: 4 })
    rememberRoom({ code: 'AAA111', token: 't3', name: 'Иван' })
    expect(recentRooms()[0].heroes).toBe('Конан')
    for (let i = 0; i < 8; i++) rememberRoom({ code: `C${i}`.padEnd(6, '0'), token: `x${i}`, name: 'Иван' })
    expect(recentRooms()).toHaveLength(6)
  })

  it('забытая комната пропадает; испорченные данные не ломают список', () => {
    rememberRoom({ code: 'AAA111', token: 't1', name: 'Иван' })
    forgetRoom('AAA111')
    expect(recentRooms()).toEqual([])
    localStorage.setItem('zchm.net.recent', '{oops')
    expect(recentRooms()).toEqual([])
  })

  it('время сохранения: сегодня — только часы, раньше — с датой', () => {
    const now = new Date(2026, 10, 20, 22, 0).getTime()
    expect(savedTime(new Date(2026, 10, 20, 21, 4).getTime(), now)).toBe('в 21:04')
    expect(savedTime(new Date(2026, 10, 18, 9, 30).getTime(), now)).toBe('18.11 в 09:30')
    expect(savedTime(new Date(2025, 0, 2, 9, 30).getTime(), now)).toBe('02.01.25 в 09:30')
  })
})
