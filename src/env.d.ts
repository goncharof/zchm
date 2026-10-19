/// <reference types="vite/client" />
/** номер сборки (vite.config.ts) — для проверки, не вышла ли новая версия */
declare const __BUILD_ID__: string
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
