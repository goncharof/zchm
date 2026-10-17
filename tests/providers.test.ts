// Цепочка моделей ведущего: OpenAI-совместимый провайдер, переход к следующей модели, сборка из окружения.
import { afterEach, describe, expect, it } from 'vitest'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { NetClient } from '@/net/client'
import type { ChatMessage } from '@/net/protocol'
import { createGameServer, type GameServer } from '../server/app'
import { aiGmFactory } from '../server/gm/ai'
import { OpenAiCompatProvider, windowHistory } from '../server/gm/openai'
import { buildProvidersFromEnv } from '../server/gm/providers'

/** Поддельный OpenAI-совместимый сервер: отвечает SSE-потоком по сценарию */
function fakeFetch(script: ((body: { messages: { role: string; content: unknown }[] }) => Response)[]) {
  const bodies: unknown[] = []
  const f = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const step = script.shift()
    if (!step) throw new Error('нет ответа в сценарии')
    return step(body)
  }) as unknown as typeof fetch
  return { f, bodies }
}
function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const textChunks = (t: string) => t.match(/.{1,10}/gs)!.map((p) => ({ choices: [{ delta: { content: p } }] }))

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

async function room(providers: ConstructorParameters<typeof OpenAiCompatProvider>[] ) {
  const ps = providers.map((args) => new OpenAiCompatProvider(...args))
  const s = await createGameServer({ port: 0, staticDir: null, world: world as unknown as WorldMap, gm: aiGmFactory({ providers: ps, cooldownScale: 0 }) })
  servers.push(s)
  const c = new NetClient(s.url)
  clients.push(c)
  let state: GameState | null = null
  const chat: ChatMessage[] = []
  c.onState((x) => { state = x })
  c.onChat((m) => chat.push(m))
  await c.create('Иван', 'ai')
  await c.call('quickStart', [])
  await c.call('enterLocation', ['zolotoy-gorod'])
  return { s, c, chat, get state() { return state! } }
}

describe('цепочка моделей ведущего', () => {
  it('OpenAI-совместимая модель вызывает инструмент и рассказывает потоком', async () => {
    const a = fakeFetch([
      // вход в локацию — простой ответ
      () => sse(textChunks('Вы у ворот Золотого города. Куда идёте?')),
      // реплика игрока — вызов инструмента частями, затем рассказ
      () => sse([
        { choices: [{ delta: { content: 'Вы идёте по коридору. ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'open_paragraph', arguments: '{"location_id":"zolotoy-gorod",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"n":1}' } }] } }] },
      ]),
      (body) => {
        const tool = body.messages.find((m) => m.role === 'tool')
        expect(String(tool?.content)).toContain('зомби')
        return sse(textChunks('Дверь охраняет угрюмый зомби. Что вы делаете?'))
      },
    ])
    const g = await room([[{ id: 'free', label: 'Бесплатная', baseUrl: 'http://fake', model: 'm' }, a.f]])
    await g.s.gm.idle()
    await g.c.chat('Идём в помещение 1', true)
    await g.s.gm.idle()
    await until(() => g.chat.some((m) => m.author === 'Ведущий · Бесплатная' && /угрюмый зомби/.test(m.text)))
    expect(g.state.visited['zolotoy-gorod']).toContain(1)
    const req = a.bodies[1] as { tools: { function: { name: string; parameters: Record<string, unknown> } }[] }
    expect(req.tools.find((t) => t.function.name === 'give_scroll')!.function.parameters).not.toHaveProperty('additionalProperties')
  })

  it('подпись мысли Gemini (extra_content) возвращается в истории; дополнительные поля уходят в запрос', async () => {
    const sig = { google: { thought_signature: 'sig-123' } }
    const a = fakeFetch([
      () => sse(textChunks('Ворота.')),
      () => sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'open_paragraph', arguments: '{"location_id":"zolotoy-gorod","n":1}' }, extra_content: sig }] } }] },
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40 } },
      ]),
      (body) => {
        const call = body.messages.find((m) => m.role === 'assistant' && 'tool_calls' in m) as unknown as { tool_calls: { extra_content?: unknown }[] }
        expect(call.tool_calls[0].extra_content).toEqual(sig)
        return sse(textChunks('Зомби у двери.'))
      },
    ])
    const g = await room([[{ id: 'gem', label: 'Gemini', baseUrl: 'http://fake', model: 'm', usage: true, extraBody: { reasoning_effort: 'low' } }, a.f]])
    await g.s.gm.idle()
    await g.c.chat('Идём в помещение 1', true)
    await g.s.gm.idle()
    await until(() => g.chat.some((m) => m.text === 'Зомби у двери.'))
    const req = a.bodies[1] as { reasoning_effort?: string; stream_options?: unknown }
    expect(req.reasoning_effort).toBe('low')
    expect(req.stream_options).toEqual({ include_usage: true })
  })

  it('первая модель на лимите — отвечает вторая; обе недоступны — сценарный ведущий', async () => {
    const limited = fakeFetch([
      () => new Response('rate limit', { status: 429, headers: { 'retry-after': '60' } }), // долгий лимит — ход уходит дальше
      () => new Response('rate limit', { status: 429 }),
    ])
    const backup = fakeFetch([
      () => sse(textChunks('Ворота города.')),
      () => new Response('down', { status: 503 }),
    ])
    const g = await room([
      [{ id: 'a', label: 'Первая', baseUrl: 'http://a', model: 'm' }, limited.f],
      [{ id: 'b', label: 'Вторая', baseUrl: 'http://b', model: 'm' }, backup.f],
    ])
    await g.s.gm.idle()
    await until(() => g.chat.some((m) => m.author === 'Ведущий · Вторая'))
    await g.c.chat('Идём в помещение 2', true)
    await g.s.gm.idle()
    await until(() => g.chat.some((m) => m.author === 'Ведущий · сценарий' && /помещение 2/.test(m.text)))
  })

  it('короткий лимит (429 с retry-after в пределах ожидания) — модель ждёт и отвечает сама', async () => {
    const a = fakeFetch([
      () => new Response('[{"error":{"code":429,"details":[{"retryDelay":"0.05s"}]}}]', { status: 429 }), // Gemini: время в теле
      () => sse(textChunks('Ворота после паузы.')),
    ])
    const g = await room([[{ id: 'q', label: 'Groq', baseUrl: 'http://fake', model: 'm' }, a.f]])
    await g.s.gm.idle()
    await until(() => g.chat.some((m) => m.author === 'Ведущий · Groq' && m.text === 'Ворота после паузы.'))
    expect(a.bodies).toHaveLength(2)
  })

  it('окно истории начинается с реплики игрока; цепочка собирается из окружения', () => {
    const hist = [
      { role: 'user', content: '1' }, { role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', tool_call_id: 'x', content: 'r' },
      { role: 'assistant', content: 'a' }, { role: 'user', content: '2' }, { role: 'assistant', content: 'b' },
    ] as Parameters<typeof windowHistory>[0]
    expect(windowHistory(hist, 4)[0]).toEqual({ role: 'user', content: '2' })
    expect(buildProvidersFromEnv({}).map((p) => p.id)).toEqual([])
    expect(buildProvidersFromEnv({ GROQ_API_KEY: 'x', GEMINI_API_KEY: 'y' }).map((p) => p.id)).toEqual(['gemini', 'groq'])
    expect(buildProvidersFromEnv({ GROQ_API_KEY: 'x', GEMINI_API_KEY: 'y', GM_CHAIN: 'groq' }).map((p) => p.label)).toEqual(['Groq'])
    expect(buildProvidersFromEnv({ LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'qwen3', LLM_LABEL: 'Ollama' }).map((p) => p.label)).toEqual(['Ollama'])
  })
})
