// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from '@/App.vue'
import { router } from '@/router'
import { useGameStore } from '@/stores/game'

const flush = async () => { await router.isReady(); await nextTick(); await new Promise((r) => setTimeout(r, 20)); await nextTick() }

describe('приложение монтируется и проходит по всем экранам без ошибок', () => {
  it('полный прогон', async () => {
    localStorage.clear()
    window.scrollTo = () => {}
    const errors: unknown[] = []
    const warns: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')) })
    const el = document.createElement('div')
    document.body.appendChild(el)
    const pinia = createPinia()
    const app = createApp(App).use(pinia).use(router)
    app.config.errorHandler = (e) => errors.push(e)
    app.mount(el)
    const store = useGameStore()
    const html = () => el.innerHTML

    await router.push('/'); await flush()
    expect(html()).toContain('Новая партия')

    await router.push('/party'); await flush()
    expect(html()).toContain('Партия')
    store.newGame()
    const w = (await store.addHero('Конан', 'warrior'))!
    const m = (await store.addHero('Мерлин', 'mage'))!
    store.addHero('Жрец', 'priest')
    await flush()
    expect(html()).toContain('Конан'); expect(html()).toContain('Книга заклинаний')

    await router.push('/shop'); await flush()
    expect(html()).toContain('Оружие')
    store.buyItem(w.uid, 'weapon', 'mech-korotkiy')
    store.equipItem(w.uid, store.hero(w.uid).inventory[0].uid)
    store.buyItem(m.uid, 'weapon', 'kinzhal')
    await flush()

    await router.push('/map'); await flush()
    expect(html()).toContain('День 1')
    await new Promise((r) => setTimeout(r, 50)); await flush()
    expect(store.world).not.toBeNull()
    expect(html()).toContain('Золотой Город')

    store.enterLocation('zolotoy-gorod')
    await router.push({ path: '/location/zolotoy-gorod', query: { p: 1 } }); await flush()
    // по этапам: сначала зомби, дверь с проверкой удачи 12 — после победы
    expect(html()).toContain('§ 1'); expect(html()).toContain('Бой: Зомби'); expect(html()).not.toContain('Бросок удачи 12')
    const r = (await store.luckCheck(w.uid, 12))!; expect(typeof r.ok).toBe('boolean')

    store.startEncounter([{ monsterId: 'zombi', count: 1 }], '/location/zolotoy-gorod?p=1')
    await router.push('/combat'); await flush()
    expect(html()).toContain('Раунд 1'); expect(html()).toContain('Зомби')
    store.toMelee(); await flush()
    let guard = 0
    while (store.combat && !store.combat.finished && guard++ < 200) {
      if (store.combat.turn === 'heroes') {
        const t = store.combat.monsters.find((x) => !x.dead && !x.fled)!
        if (!store.combat.acted.includes(w.uid)) store.attack(w.uid, 'rightHand', t.uid)
        if (store.combat && !store.combat.finished && !store.combat.acted.includes(m.uid)) store.cast(m.uid, 'mage-magicheskaya-strela', { targetUid: t.uid, param: 1 })
        if (store.combat && !store.combat.finished) for (const h of store.heroes) if (!store.combat.acted.includes(h.uid) && store.combat.turn === 'heroes') store.skip(h.uid)
      } else store.monstersAct()
      await flush()
    }
    expect(store.combat?.finished).toBeDefined()
    expect(html()).toMatch(/Победа|Отступление|Поражение/)
    store.endCombat(); await flush()

    await router.push('/bestiary'); await flush()
    expect(html()).toContain('Бестиарий')
    await router.push('/spells'); await flush()
    expect(html()).toContain('Заклинания жреца')
    await router.push('/about'); await flush()
    expect(html()).toContain('Об игре')
    await router.push('/location/doroga'); await flush()
    expect(html()).toContain('Дорога')

    const vueWarns = warns.filter((x) => /\[Vue warn\]/.test(x))
    expect(vueWarns, vueWarns.join('\n')).toEqual([])
    expect(errors, errors.map(String).join('\n')).toEqual([])
    expect(JSON.parse(localStorage.getItem('zchm.save.v1')!).heroes).toHaveLength(3)
  })
})
