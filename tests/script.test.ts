// Сценарный ведущий без ИИ: сцены, кнопки-варианты, действия движком.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { seededRng, setRng } from '@/engine/dice'
import { createGameServer, type GameServer } from '../server/app'

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

async function setup() {
  setRng(seededRng(5))
  const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap })
  servers.push(s)
  const c = new NetClient(s.url)
  clients.push(c)
  let state: GameState | null = null
  const chat: ChatMessage[] = []
  c.onState((x) => { state = x })
  c.onChat((m) => chat.push(m))
  c.onChatUpdate((m) => { const i = chat.findIndex((x) => x.id === m.id); if (i >= 0) chat[i] = m })
  await c.create('Иван', 'script')
  await c.call('quickStart', [])
  return { s, c, chat, get state() { return state! } }
}
const lastGm = (chat: ChatMessage[]) => [...chat].reverse().find((m) => m.from === 'gm')!

describe('сценарный ведущий', () => {
  it('вход в локацию, номер помещения → сцена с вариантами; проверка удачи и бой выполняются движком', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['zolotoy-gorod'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('Идём в помещение 1', true)
    await until(() => g.chat.some((m) => m.from === 'gm' && /помещение 1/.test(m.text)))
    const scene = lastGm(g.chat)
    expect(scene.text).toContain('зомби')
    expect(scene.text).not.toContain('дарит вам (6)') // исход ветки скрыт до выбора
    const labels = scene.choices!.map((c) => c.label)
    expect(labels.some((l) => l.startsWith('⚔ Бой: Зомби'))).toBe(true)
    expect(labels.some((l) => l.includes('удачи 12'))).toBe(true)
    expect(labels.some((l) => l.startsWith('▸ Если вы его освобождаете'))).toBe(true)
    expect(g.state.visited['zolotoy-gorod']).toContain(1)

    const luck = scene.choices!.find((c) => c.label.includes('удачи 12'))!
    await g.c.choose(scene.id, luck.id)
    await until(() => lastGm(g.chat).text.includes('испытывает удачу'))
    await expect(g.c.choose(scene.id, luck.id)).rejects.toThrow(/уже выбран/)

    const branch = scene.choices!.find((c) => c.label.startsWith('▸'))!
    await g.c.choose(scene.id, branch.id)
    await until(() => /дарит вам \(6\)/.test(lastGm(g.chat).text))
    const outcome = lastGm(g.chat)
    const bottle = outcome.choices!.find((c) => c.label.startsWith('Взять бутылку (6)'))!
    await g.c.choose(outcome.id, bottle.id)
    await until(() => g.state.heroes.some((h) => h.inventory.some((e) => e.kind === 'bottle')))

    const fight = scene.choices!.find((c) => c.label.startsWith('⚔'))!
    await g.c.choose(scene.id, fight.id)
    await until(() => !!g.state.combat)
    expect(g.state.combat!.monsters[0].monsterId).toBe('zombi')
  })

  it('свободная реплика без номера — подсказка; плата без денег не проходит и вариант снова доступен', async () => {
    const g = await setup()
    await g.c.chat('Поговорим с трактирщиком', true)
    await until(() => lastGm(g.chat)?.text.includes('понимает номера'))
    await g.c.call('enterLocation', ['zamok-zhretsov'])
    await g.c.chat('17', true)
    await until(() => /помещение 17/.test(lastGm(g.chat)?.text ?? ''))
    const scene = lastGm(g.chat)
    const pay = scene.choices!.find((c) => c.label === 'Заплатить 10 монет')!
    // жрец быстрого старта потратил все 40 монет на палицу: платить нечем
    const priest = g.state.heroes.find((h) => h.classId === 'priest')!
    expect(priest.money).toBe(0)
    await g.c.claimHero(priest.uid)
    await g.c.choose(scene.id, pay.id)
    await until(() => /не хватает монет/i.test(lastGm(g.chat).text))
    expect(g.chat.find((m) => m.id === scene.id)!.used ?? []).not.toContain(pay.id)
  })
})
