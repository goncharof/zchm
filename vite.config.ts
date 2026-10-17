import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// base './' — сборка работает из любого подкаталога (GitHub Pages, file://)
export default defineConfig({
  base: './',
  plugins: [vue()],
  // JSON как строка + JSON.parse: быстрее разбирается браузером
  json: { stringify: true },
  server: {
    // сетевая игра в разработке: pnpm server (порт 8787) + pnpm dev
    proxy: { '/socket.io': { target: 'http://localhost:8787', ws: true } },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // данные игры отдельным чанком: кэшируются, пока меняется только код
        manualChunks(id: string) {
          if (id.includes('/src/data/') && id.endsWith('.json') && !id.endsWith('lore.json')) return 'game-data'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
