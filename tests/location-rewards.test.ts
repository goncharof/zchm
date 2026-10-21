// @vitest-environment jsdom
// Награды и броски из Книги Жизни без ведущего: берутся один раз на партию, списки «на каждый» бросаются снова.
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ParagraphActions from '@/components/ParagraphActions.vue'
import BookStages from '@/components/BookStages.vue'
import { idx } from '@/data'
import type { Paragraph } from '@/types'
import { setRng } from '@/engine/dice'
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
    const roll = (repeat: boolean): Paragraph => ({ n: 54, segments: [{ kind: 'scene', blocks: [{ text: 'Перед вами черепа.' }, { roll: [{ values: [1, 2, 3], text: 'ничего' }, { values: [4, 5, 6], text: 'находка' }], ...(repeat ? { repeat: true } : {}) }] }] })
    let paragraph = roll(false)
    const once = mount(BookStages, () => ({ loc: 'doroga', locName: 'Дорога', paragraph, heroUid: '' }))
    const store = useGameStore()
    store.newGame()
    once.app.mount(once.el); await flush()
    button(once.el, 'Бросить к6').click(); await flush()
    expect(button(once.el, 'Брошено').disabled).toBe(true)
    // выпавший исход открылся этапом, остальные скрыты
    expect(once.el.textContent).toMatch(/Выпало (1, 2, 3|4, 5, 6)/)
    expect(once.el.textContent?.includes('ничего') !== once.el.textContent?.includes('находка')).toBe(true)
    once.app.unmount()
    paragraph = roll(true)
    const many = createApp({ render: () => h(BookStages, { loc: 'doroga', locName: 'Дорога', paragraph, heroUid: '' }) }).use(once.pinia)
    const el2 = document.createElement('div'); document.body.appendChild(el2)
    many.mount(el2); await flush()
    const b = button(el2, 'Бросить к6 (на каждый)')
    expect(b.disabled).toBe(false)
    b.click(); await flush(); b.click(); await flush()
    expect(store.game!.log.filter((e) => e.text.includes('к6 =')).length).toBeGreaterThanOrEqual(3)
    many.unmount()
  })

  it('по этапам: вариант открывается выбором, исход провала проверки — сам, исход удачи скрыт', async () => {
    localStorage.clear()
    const paragraph = idx.locationById.get('upokoische')!.paragraphs.find((p) => p.n === 26)!
    let heroUid = ''
    const m = mount(BookStages, () => ({ loc: 'upokoische', locName: 'Упокоище', paragraph, heroUid }))
    const store = useGameStore()
    store.newGame()
    heroUid = (await store.addHero('Конан', 'warrior'))!.uid
    m.app.mount(m.el); await flush()
    expect(m.el.textContent).not.toContain('Падаете без чувств')
    const luck = button(m.el, 'Бросок удачи 8')
    setRng(() => 0) // к18 = 1 — провал
    luck.click(); await flush()
    expect(m.el.textContent).toContain('Падаете без чувств')
    expect(m.el.textContent).not.toContain('Если перерубаете')
    expect(m.errors).toEqual([])
    m.app.unmount()
  })
})
