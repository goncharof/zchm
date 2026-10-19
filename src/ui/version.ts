import { ref } from 'vue'

/** Вышла новая версия игры: открытая давно вкладка сверяет свою сборку с version.json на сервере */
export const updateAvailable = ref(false)

async function check(): Promise<void> {
  if (updateAvailable.value) return
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return
    const { build } = (await r.json()) as { build?: string }
    if (build && build !== __BUILD_ID__) updateAvailable.value = true
  } catch { /* нет сети — проверим в следующий раз */ }
}

/** Проверять при возвращении на вкладку и раз в 15 минут (только в собранной игре) */
export function watchForUpdates(): void {
  if (!import.meta.env.PROD) return
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check() })
  setInterval(() => { void check() }, 15 * 60_000)
}
