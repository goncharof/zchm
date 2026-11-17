// Рассказчик поверх сценарного ведущего: модель дописывает атмосферу к сцене, хозяин может выключить, мусор отсеивается.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { NetClient } from '@/net/client'
import type { ChatMessage, RoomView } from '@/net/protocol'
import { seededRng, setRng } from '@/engine/dice'
import { createGameServer, type GameServer } from '../server/app'
import { aiGmFactory } from '../server/gm/ai'
import { cleanNarration } from '../server/gm/narrator'
import type { LlmProvider } from '../server/gm/types'

let servers: GameServer[] = []
let clients: NetClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
})
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait() }
}

describe('рассказчик', () => {
  it('дописывает к сцене две фразы от модели, после выключения — запасную строку без запроса', async () => {
    setRng(seededRng(3))
    const seen: string[] = []
    const fake: LlmProvider = {
      id: 'fake', label: 'Fake',
      turn: async () => { throw new Error('ведущий не нужен') },
      complete: async (_system, user) => { seen.push(user); return '«Факелы чадят, и где-то капает вода.» Пахнет сыростью! А это третья фраза.' },
    }
    const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap, gm: aiGmFactory({ providers: [fake], cooldownScale: 0 }) })
    servers.push(s)
    const c = new NetClient(s.url)
    clients.push(c)
    const chat: ChatMessage[] = []
    let room: RoomView | null = null
    c.onChat((m) => chat.push(m))
    c.onChatUpdate((m) => { const i = chat.findIndex((x) => x.id === m.id); if (i >= 0) chat[i] = m })
    c.onRoom((r) => { room = r })
    await c.create('Иван', 'script')
    await c.call('quickStart', [])
    await until(() => room?.narrator === true && room.gmChain.includes('Fake'))
    await c.call('enterLocation', ['zolotoy-gorod'])
    await c.chat('1', true)
    const scene = () => chat.find((m) => m.from === 'gm' && m.text.includes('помещение 1'))
    await until(() => !!scene()?.text.includes('Факелы чадят'))
    expect(scene()!.text).toContain('Факелы чадят, и где-то капает вода. Пахнет сыростью!')
    expect(scene()!.text).not.toContain('третья фраза')
    // модели уходит только видимая сцена: место, событие, текст книги
    expect(seen[0]).toContain('Место: Золотой город, помещение 1')
    expect(seen[0]).toContain('зомби')
    // хозяин выключил — модель не дёргается, остаётся запасная строка
    await c.setNarrator(false)
    await until(() => room?.narrator === false)
    await c.chat('3', true)
    await until(() => !!chat.find((m) => m.from === 'gm' && m.text.includes('помещение 3')))
    await wait(100)
    expect(seen).toHaveLength(1)
    expect(chat.find((m) => m.from === 'gm' && m.text.includes('помещение 3'))!.text).not.toContain('Факелы')
  })

  it('чистит ответ модели: кавычки, две фразы, мусор — null', () => {
    expect(cleanNarration('  «Ветер воет в бойницах. Пахнет гарью. Третья.»  ')).toBe('Ветер воет в бойницах. Пахнет гарью.')
    expect(cleanNarration('- пункт один\n- пункт два')).toBeNull()
    expect(cleanNarration('The wind howls here.')).toBeNull()
    expect(cleanNarration('[Сцена] тихо')).toBeNull()
    expect(cleanNarration('Тихо.')).toBeNull()
    expect(cleanNarration('')).toBeNull()
  })
})
