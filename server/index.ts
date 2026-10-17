/**
 * Точка входа сервера.
 *   pnpm server           — разработка (tsx), порт 8787; фронтенд — pnpm dev (Vite проксирует /socket.io)
 *   pnpm build && pnpm build:server && node server-dist/index.js — продакшен: статика dist + сокеты на одном порту
 * Переменные окружения: PORT, HOST, DATA_DIR (по умолчанию ./data/rooms), STATIC_DIR (по умолчанию ./dist),
 * Модели ИИ-ведущего — см. server/gm/providers.ts (GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY,
 * OPENROUTER_API_KEY, LLM_BASE_URL+LLM_MODEL, ANTHROPIC_API_KEY, GM_CHAIN). Без них ходы ведёт сценарный ведущий.
 */
import path from 'node:path'
import type { WorldMap } from '@/types'
import world from '@/data/world.json'
import { createGameServer } from './app'
import { aiGmFactory } from './gm/ai'
import { buildProvidersFromEnv } from './gm/providers'

const port = Number(process.env.PORT ?? 8787)
const root = process.cwd()
const server = await createGameServer({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  staticDir: process.env.STATIC_DIR ?? path.join(root, 'dist'),
  dataDir: process.env.DATA_DIR ?? path.join(root, 'data', 'rooms'),
  world: world as unknown as WorldMap,
  gm: aiGmFactory({ providers: buildProvidersFromEnv() }),
})
const chain = server.gm.chain()
console.log(`Заклятье Чёрного мага: сервер на ${server.url}. Ведущий: ${chain.length ? `${chain.join(' → ')} → сценарный` : 'сценарный (модели ИИ не настроены)'}`)

const stop = async () => {
  console.log('Останавливаю сервер, сохраняю комнаты…')
  await server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
