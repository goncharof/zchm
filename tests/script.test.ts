// Сценарный ведущий без ИИ: сцены, кнопки-варианты, действия движком.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { seededRng, setRng } from '@/engine/dice'
import { createGameServer, type GameServer } from '../server/app'
import { luckPenalty } from '../server/gm/script'
import { checkEnd } from '@/engine/combat'

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
  const j = await c.create('Иван', 'script')
  await c.call('quickStart', [])
  return { s, c, j, chat, get state() { return state! } }
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

  it('последствие провала берётся из текста книги', () => {
    expect(luckPenalty('пускает молнию (удача — 6, иначе смерть)', 6)).toMatchObject({ kind: 'death' })
    expect(luckPenalty('2 берсеркера. Удача — 14, иначе — -2 жизни', 14)).toMatchObject({ kind: 'lives', amount: 2, text: '−2 жизни' })
    expect(luckPenalty('Впереди водопад. Удача — 12, иначе — 1 жизнь', 12)).toMatchObject({ kind: 'lives', amount: 1, text: '−1 жизнь' })
    expect(luckPenalty('Удача — 12, иначе половина жизней исчезает', 12)).toMatchObject({ kind: 'half' })
    expect(luckPenalty('вас охватывает паралич (удача — 13, жизни не отнимаются)', 13)).toBeNull()
    expect(luckPenalty('Удача — 14, иначе — -2 жизни', 4)).toBeNull()
  })

  it('провал проверки удачи: кнопка последствия из текста отнимает жизни у проверявшего героя', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['krepost-posledney-nadezhdy'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('29', true)
    await until(() => lastGm(g.chat).text.includes('помещение 29'))
    const scene = lastGm(g.chat)
    setRng(() => 0) // к18 = 1 — провал
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label.includes('удачи 14'))!.id)
    await until(() => lastGm(g.chat).text.includes('испытывает удачу'))
    const res = lastGm(g.chat)
    expect(res.text).toContain('По книге: иначе — −2 жизни')
    const hero = g.state.heroes.find((h) => res.text.startsWith(h.name))!
    const before = hero.lives
    await g.c.choose(res.id, res.choices!.find((c) => c.label === 'Принять последствия: −2 жизни')!.id)
    await until(() => g.state.heroes.find((h) => h.uid === hero.uid)!.lives === before - 2)
  })

  it('после боя из параграфа предлагается ветка победы', async () => {
    const g = await setup()
    await g.c.call('enterLocation', ['krepost-posledney-nadezhdy'])
    await until(() => g.chat.some((m) => m.from === 'gm' && /Назовите номер/.test(m.text)))
    await g.c.chat('40', true)
    await until(() => lastGm(g.chat).text.includes('помещение 40'))
    const scene = lastGm(g.chat)
    await g.c.choose(scene.id, scene.choices!.find((c) => c.label === '▸ Соглашаетесь')!.id)
    await until(() => lastGm(g.chat).text.includes('Сражаетесь с рыцарем'))
    const branch = lastGm(g.chat)
    await g.c.choose(branch.id, branch.choices!.find((c) => c.label.startsWith('⚔ Бой: Рыцарь'))!.id)
    await until(() => !!g.state.combat)
    const room = (await g.s.store.get(g.j.code))!
    for (const m of room.state.combat!.monsters) m.dead = true
    checkEnd(room.state.combat!, room.state.heroes)
    await g.c.call('endCombat', [])
    await until(() => lastGm(g.chat).text.includes('Что дальше по книге'))
    expect(lastGm(g.chat).choices!.map((c) => c.label)).toEqual(['▸ Побеждаете', 'Идти дальше'])
  })
})
