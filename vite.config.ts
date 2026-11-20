import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'

/** Номер сборки: вшивается в код и кладётся в version.json — открытая давно вкладка узнаёт, что вышла новая версия */
const BUILD_ID = Date.now().toString(36)
function versionFile(): Plugin {
  return {
    name: 'zchm-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
    },
  }
}

// base './' — сборка работает из любого подкаталога (GitHub Pages, file://)
export default defineConfig(({ isSsrBuild }) => ({
  base: './',
  // номер сборки — только у фронтенда (сборке сервера он не нужен)
  plugins: [vue(), ...(isSsrBuild ? [] : [versionFile()])],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // JSON как строка + JSON.parse: быстрее разбирается браузером
  json: { stringify: true },
  server: {
    // сетевая игра в разработке: pnpm server (порт 8787) + pnpm dev
    proxy: { '/socket.io': { target: 'http://localhost:8787', ws: true } },
  },
  build: {
    // сборка сервера (--ssr) не копирует картинки: их раздаёт dist
    copyPublicDir: !isSsrBuild,
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
    setupFiles: ['tests/setup.ts'],
  },
}))
