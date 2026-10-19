// @vitest-environment jsdom
// Награды и броски из Книги Жизни без ведущего: берутся один раз на партию, списки «на каждый» бросаются снова.
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ParagraphActions from '@/components/ParagraphActions.vue'
import RollBlock from '@/components/RollBlock.vue'
import { useGameStore } from '@/stores/game'

const flush = async () => { await nextTick(); await new Promise((r) => setTimeout(r, 10)); await nextTick() }
function mount(component: unknown, props: () => Record<string, unknown>) {
  const el = document.createElement('div'); document.body.appendChild(el)
  const pinia = createPinia(); setActivePinia(pinia)
  const app = createApp({ render: () => h(component as never, props()) }).use(pinia)
  const errors: unknown[] = []
  app.config.errorHandler = (e) => errors.push(e)
  return { el, app, pinia, errors }
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement

describe('награды Книги Жизни без ведущего', () => {
  it('монеты из текста берутся один раз, даже если параграф открыть заново', async () => {
    localStorage.clear()
    let heroUid = ''
    const m = mount(ParagraphActions, () => ({ hints: { coins: [20] }, heroUid, place: 'zolotoy-gorod:22:0' }))
    const store = useGameStore()
    store.newGame()
    heroUid = (await store.addHero('Конан', 'warrior'))!.uid
    m.app.mount(m.el)
    await flush()
    button(m.el, '+20 монет').click(); await flush()
    expect(store.hero(heroUid).money).toBe(60)
    expect(button(m.el, '+20 монет').disabled).toBe(true)
    // «повторное открытие»: компонент создаётся заново, отметка — в состоянии партии
    m.app.unmount()
    const again = createApp({ render: () => h(ParagraphActions, { hints: { coins: [20] }, heroUid, place: 'zolotoy-gorod:22:0' }) }).use(m.pinia)
    const el2 = document.createElement('div'); document.body.appendChild(el2)
    again.mount(el2); await flush()
    expect(button(el2, '+20 монет').disabled).toBe(true)
    expect(m.errors).toEqual([])
    again.unmount()
  })

  it('обычный список бросают один раз, список «на каждый» — снова', async () => {
    localStorage.clear()
    const options = [{ values: [1, 2, 3], text: 'ничего' }, { values: [4, 5, 6], text: 'находка' }]
    const once = mount(RollBlock, () => ({ options, place: 'doroga:54:0:1' }))
    const store = useGameStore()
    store.newGame()
    once.app.mount(once.el); await flush()
    button(once.el, 'Бросить').click(); await flush()
    expect(button(once.el, 'Брошено').disabled).toBe(true)
    once.app.unmount()
    const many = createApp({ render: () => h(RollBlock, { options, place: 'doroga:54:0:1', repeat: true }) }).use(once.pinia)
    const el2 = document.createElement('div'); document.body.appendChild(el2)
    many.mount(el2); await flush()
    const roll = button(el2, 'Бросить')
    expect(roll.disabled).toBe(false)
    roll.click(); await flush(); roll.click(); await flush()
    expect(store.game!.log.filter((e) => e.text.includes('к6 =')).length).toBeGreaterThanOrEqual(3)
    many.unmount()
  })
})
