// ИИ-ведущий на имитации модели: цикл с инструментами, стриминг, откат при ошибке.
import { afterEach, describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'
import { aiGmFactory, type ModelClient } from '../server/gm/ai'
import { GM_TOOLS } from '../server/gm/tools'

type Reply = { text?: string; tools?: { name: string; input: unknown }[]; error?: Error }

/** Имитация модели: по очереди отдаёт заготовленные ответы и запоминает запросы */
function fakeModel(replies: Reply[]) {
  const calls: unknown[] = []
  const client: ModelClient = {
    stream(params) {
      calls.push(JSON.parse(JSON.stringify(params)))
      const r = replies.shift() ?? { text: '…' }
      let onText: ((d: string) => void) | null = null
      return {
        on(_e: 'text', cb: (d: string) => void) { onText = cb; return this },
        async finalMessage() {
          if (r.error) throw r.error
          if (r.text) for (const part of r.text.match(/.{1,12}/gs) ?? []) onText?.(part)
          const content = [
            ...(r.text ? [{ type: 'text', text: r.text, citations: null }] : []),
            ...(r.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${calls.length}_${i}`, name: t.name, input: t.input })),
          ]
          return { id: 'msg', type: 'message', role: 'assistant', model: 'fake', content, stop_reason: r.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Beta.BetaMessage
        },
      }
    },
  }
  return { client, calls }
}

let servers: GameServer[] = []
let clients: NetClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  for (const s of servers) await s.close()
  servers = []; clients = []
})
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait() }
}

async function setup(replies: Reply[], maxHistoryChars?: number) {
  const model = fakeModel(replies)
  const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap, gm: aiGmFactory({ client: model.client, logUsage: false, cooldownScale: 0, anthropic: { maxHistoryChars } }) })
  servers.push(s)
  const c = new NetClient(s.url)
  clients.push(c)
  let state: GameState | null = null
  const chat: ChatMessage[] = []
  const deltas: string[] = []
  const notices: string[] = []
  c.onState((x) => { state = x })
  c.onChat((m) => chat.push(m))
  c.onGmDelta((d) => deltas.push(d.text))
  c.onNotice((t) => notices.push(t))
  const j = await c.create('Иван', 'ai')
  await c.call('quickStart', [])
  return { s, c, model, j, chat, deltas, notices, get state() { return state! } }
}

describe('ИИ-ведущий', () => {
  it('инструменты фиксированы и строгие', () => {
    expect(GM_TOOLS.map((t) => t.name)).toContain('open_paragraph')
    for (const t of GM_TOOLS) { expect(t.strict).toBe(true); expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false) }
  })

  it('ход: реплика игрока → чтение параграфа → рассказ стримом в чат', async () => {
    const g = await setup([
      { text: 'Вы входите в город.', tools: [{ name: 'open_paragraph', input: { location_id: 'zolotoy-gorod', n: 1 } }] },
      { text: 'Узкий коридор ведёт к железной двери. Что вы делаете?' },
    ])
    await g.c.chat('Идём в комнату 1', true)
    await g.s.gm!.idle()
    await until(() => g.chat.some((m) => m.from === 'gm' && /железной двери/.test(m.text)))
    expect(g.deltas.join('')).toContain('железной двери')
    expect(g.state.visited['zolotoy-gorod']).toContain(1)
    const req = g.model.calls.at(-1) as { messages: { role: string; content: unknown }[]; system: { cache_control?: unknown }[]; fallbacks: string; output_config: { effort: string } }
    const roles = req.messages.map((m) => m.role)
    expect(roles).toContain('system')
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(req.fallbacks).toBe('default')
    expect(req.output_config.effort).toBe('medium')
    // результат инструмента (последнее сообщение второго запроса) содержит полный текст параграфа
    expect(JSON.stringify(req.messages.at(-1))).toContain('зомби')
    expect(g.model.calls).toHaveLength(2)
  })

  it('бой начинается инструментом; игроку нельзя выдать себе монеты', async () => {
    const g = await setup([
      { text: 'Из темноты выходят орки!', tools: [{ name: 'start_combat', input: { monsters: [{ id: 'ork', count: 2 }] } }] },
      { text: 'Бой начался.' },
    ])
    await g.c.chat('Осматриваемся', true)
    await g.s.gm!.idle()
    await until(() => !!g.state?.combat)
    expect(g.state.combat!.monsters).toHaveLength(2)
    const uid = g.state.heroes[0].uid
    await expect(g.c.call('adjustMoney', [uid, 1000])).rejects.toThrow(/решает ведущий/)
  })

  it('ошибка API: ход откатывается, его берёт сценарный ведущий, следующий ход снова у модели', async () => {
    const err = new Anthropic.APIError(500, undefined, 'boom', new Headers())
    const g = await setup([{ error: err }, { text: 'Продолжаем.' }])
    await g.c.chat('Ау', true)
    await g.s.gm!.idle()
    await until(() => g.notices.some((n) => /сценарный ведущий/.test(n)))
    await until(() => g.chat.some((m) => m.author === 'Ведущий · сценарий'))
    const room = (await g.s.store.get(g.j.code))!
    expect(room.gmHistories.claude ?? []).toHaveLength(0)
    await g.c.chat('Ещё раз', true)
    await g.s.gm!.idle()
    await until(() => g.chat.some((m) => m.from === 'gm' && m.text === 'Продолжаем.'))
    expect((room.gmHistories.claude as { role: string }[]).map((m) => m.role)).toEqual(['user', 'system', 'assistant'])
    // модель получила сводку того, что ход вёл сценарный ведущий
    const req = g.model.calls.at(-1) as { messages: { role: string; content: { text?: string }[] }[] }
    expect(JSON.stringify(req.messages[0])).toContain('сценарий')
  })

  it('длинная партия: история заменяется кратким содержанием прошлых сцен', async () => {
    const g = await setup([{ text: 'Первая сцена у ворот.' }, { text: 'Вторая сцена в таверне.' }, { text: 'Третья сцена.' }], 200)
    await g.c.chat('Осматриваемся у ворот', true)
    await g.s.gm.idle()
    await g.c.chat('Идём в таверну', true)
    await g.s.gm.idle()
    await g.c.chat('Что дальше?', true)
    await g.s.gm.idle()
    await until(() => g.chat.some((m) => m.text === 'Третья сцена.'))
    const last = g.model.calls.at(-1) as { messages: { role: string; content: { text?: string }[] }[] }
    expect(last.messages[0].content[0].text).toContain('Краткое содержание прошлой игры')
    expect(last.messages[0].content[0].text).toContain('Вторая сцена в таверне.')
    expect(last.messages.length).toBeLessThanOrEqual(2)
  })

  it('пачка реплик (ход по готовности) уходит модели одним запросом', async () => {
    const g = await setup([{ text: 'Отвечаю обоим.' }])
    const room = (await g.s.store.get(g.j.code))!
    g.s.gm.enqueue(room, [
      { kind: 'player', author: 'Иван', text: 'Иду налево' },
      { kind: 'player', author: 'Пётр', text: 'Иду направо' },
    ])
    await g.s.gm.idle()
    expect(g.model.calls).toHaveLength(1)
    const req = g.model.calls[0] as { messages: { content: { text?: string }[] }[] }
    expect(req.messages[0].content[0].text).toContain('Иду налево')
    expect(req.messages[0].content[0].text).toContain('Иду направо')
  })
})
