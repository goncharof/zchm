/**
 * Сервер с демо-ведущим вместо Claude API — для визуальной проверки сетевой игры без ключа.
 * Запуск: pnpm exec tsx tools/qa/fake-gm-server.ts  (порт 8787, Vite проксирует /socket.io)
 * Демо-ведущий настоящими инструментами открывает параграф, когда игрок называет номер помещения,
 * и пересказывает начало текста. Это не ИИ: только для проверки интерфейса и цикла инструментов.
 */
import type Anthropic from '@anthropic-ai/sdk'
import world from '@/data/world.json'
import type { WorldMap } from '@/types'
import { createGameServer } from '../../server/app'
import { aiGmFactory, type ModelClient } from '../../server/gm/ai'

type Msg = Anthropic.Beta.BetaMessageParam
const textOf = (m: Msg | undefined) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((b) => ('text' in b ? b.text : '')).join(' '))

let n = 0
const fake: ModelClient = {
  stream(params) {
    const msgs = params.messages as Msg[]
    const last = msgs.at(-1)
    let text = ''
    let tool: { name: string; input: unknown } | null = null
    const toolResult = Array.isArray(last?.content) ? last!.content.find((b) => b.type === 'tool_result') : undefined
    if (toolResult && 'content' in toolResult) {
      const raw = typeof toolResult.content === 'string' ? toolResult.content : ''
      try {
        const r = JSON.parse(raw) as { текст?: string }
        text = r.текст ? `(Демо-ведущий пересказывает книгу.) ${r.текст.slice(0, 380)}… Что вы делаете?` : `Ход сделан: ${raw.slice(0, 200)}`
      } catch { text = `Ход сделан: ${raw.slice(0, 200)}` }
    } else {
      const snapshot = textOf(last)
      const userText = textOf(msgs.at(-2))
      const loc = snapshot.match(/\(id ([a-z-]+)\)/)?.[1]
      const room = userText.match(/помещение (\d+)/)?.[1]
      if (loc && room) {
        text = `Вы направляетесь в помещение ${room}.`
        tool = { name: 'open_paragraph', input: { location_id: loc, n: Number(room) } }
      } else if (/Партия входит/.test(userText)) {
        text = 'Перед вами ворота. Стражники лениво провожают вас взглядом. Куда пойдёте? Назовите номер помещения на плане.'
      } else {
        text = `Демо-ведущий слышит вас: ${userText.slice(0, 160)} Назовите номер помещения на плане.`
      }
    }
    let onText: ((d: string) => void) | null = null
    return {
      on(_e: 'text', cb: (d: string) => void) { onText = cb; return this },
      async finalMessage() {
        for (const part of text.match(/.{1,8}/gs) ?? []) { onText?.(part); await new Promise((r) => setTimeout(r, 8)) }
        n++
        const content = [{ type: 'text', text, citations: null }, ...(tool ? [{ type: 'tool_use', id: `demo_${n}`, name: tool.name, input: tool.input }] : [])]
        return { id: `demo_${n}`, type: 'message', role: 'assistant', model: 'demo', content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Beta.BetaMessage
      },
    }
  },
}

const s = await createGameServer({ port: Number(process.env.PORT ?? 8787), staticDir: null, dataDir: null, world: world as unknown as WorldMap, gm: aiGmFactory({ client: fake, logUsage: false }) })
console.log(`Демо-сервер с поддельным ведущим: ${s.url}`)
