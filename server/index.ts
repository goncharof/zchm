/**
 * Точка входа сервера.
 *   pnpm server           — разработка (tsx), порт 8787; фронтенд — pnpm dev (Vite проксирует /socket.io)
 *   pnpm build && pnpm build:server && node server-dist/index.js — продакшен: статика dist + сокеты на одном порту
 * Переменные окружения: PORT, HOST, DATA_DIR (по умолчанию ./data/rooms), STATIC_DIR (по умолчанию ./dist),
 * ANTHROPIC_API_KEY — включает ИИ-ведущего; GM_MODEL, GM_EFFORT — настройки модели.
 */
import path from 'node:path'
import type { WorldMap } from '@/types'
import world from '@/data/world.json'
import { createGameServer } from './app'
import { aiGmFactory, aiConfigured } from './gm/ai'

const port = Number(process.env.PORT ?? 8787)
const root = process.cwd()
const server = await createGameServer({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  staticDir: process.env.STATIC_DIR ?? path.join(root, 'dist'),
  dataDir: process.env.DATA_DIR ?? path.join(root, 'data', 'rooms'),
  world: world as unknown as WorldMap,
  gm: aiConfigured() ? aiGmFactory() : undefined,
})
console.log(`Заклятье Чёрного мага: сервер на ${server.url}${server.gm ? ' (ИИ-ведущий включён)' : ' (ИИ-ведущий выключен: нет ANTHROPIC_API_KEY)'}`)

const stop = async () => {
  console.log('Останавливаю сервер, сохраняю комнаты…')
  await server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
