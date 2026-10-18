// @vitest-environment jsdom
// Экран боя не падает на призванном существе без статьи в Бестиарии (элементал, призванный монстром).
import { describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from '@/App.vue'
import { router } from '@/router'
import { useGameStore } from '@/stores/game'

describe('экран боя', () => {
  it('показывает призванного элементала', async () => {
    localStorage.clear()
    window.scrollTo = () => {}
    const errors: unknown[] = []
    const el = document.createElement('div'); document.body.appendChild(el)
    const app = createApp(App).use(createPinia()).use(router)
    app.config.errorHandler = (e) => errors.push(e)
    app.mount(el)
    const store = useGameStore()
    store.newGame()
    await store.addHero('Конан', 'warrior')
    store.startEncounter([{ monsterId: 'ork', count: 1 }])
    store.combat!.monsters.push({ ...store.combat!.monsters[0], uid: 'mon-el', monsterId: 'elemental', name: 'Земной элементал', summoned: true })
    await router.push('/combat'); await router.isReady(); await nextTick(); await new Promise((r) => setTimeout(r, 20)); await nextTick()
    expect(errors).toEqual([])
    expect(el.innerHTML).toContain('Земной элементал')
    app.unmount()
  })
})
