// Визуальный прогон: проходит игру через интерфейс и снимает скриншоты.
// Запуск: pnpm dev (в другом терминале), затем `node tools/qa/screens.mjs [url] [outDir]`
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:5177/'
const OUT = process.argv[3] ?? 'tools/qa/out'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const problems = []

async function run(label, viewport, touch = false) {
  // touch: телефон с касаниями — без наведения мышью, pointer: coarse (крупные кнопки, поля 16 px)
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(touch ? { isMobile: true, hasTouch: true } : {}) })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${label}] console.${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${label}] HTTP ${r.status()}: ${r.url()}`) })
  const shot = async (name) => {
    await page.waitForTimeout(250)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 2) problems.push(`[${label}] ${name}: горизонтальная прокрутка ${overflow}px`)
    await page.screenshot({ path: `${OUT}/${label}-${name}.png`, fullPage: true })
  }
  await page.goto(BASE)
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE)
  await shot('01-home')

  await page.getByRole('button', { name: 'Новая партия' }).click()
  for (const [name, cls] of [['Конан', 'warrior'], ['Мерлин', 'mage'], ['Брат Тук', 'priest'], ['Бильбо', 'thief']]) {
    await page.getByPlaceholder('Например, Конан').fill(name)
    await page.locator('details.add-hero select').first().selectOption(cls)
    await page.getByRole('button', { name: 'Добавить в партию' }).click()
  }
  await shot('02-party')

  await page.getByRole('button', { name: 'Лавка (снаряжение)' }).click()
  const buyer = page.locator('select').first()
  const buy = async (heroIdx, tab, item) => {
    await buyer.selectOption({ index: heroIdx })
    await page.getByRole('button', { name: tab, exact: true }).click()
    await page.locator('tr', { hasText: item }).first().getByRole('button', { name: 'Купить' }).click()
  }
  await buy(0, 'Оружие', 'меч короткий')
  await buy(0, 'Доспехи', 'кожаный доспех')
  await buy(1, 'Оружие', 'кинжал')
  await buy(2, 'Оружие', 'палица')
  await buy(3, 'Оружие', 'арбалет')
  await buyer.selectOption({ index: 3 })
  await page.locator('tr', { hasText: /^\s*стрела/ }).first().getByRole('button', { name: '×10' }).click()
  await page.getByRole('button', { name: 'Оружие', exact: true }).click()
  await shot('03-shop')

  // экипировка через лист персонажа
  await page.goto(BASE + '#/party')
  // телефон: листы героев по одному — показать всех
  const allTab = page.locator('.hero-switch button', { hasText: 'Все' })
  if (await allTab.count()) await allTab.click()
  for (let i = 0; i < 12; i++) {
    const btn = page.getByRole('button', { name: 'Надеть', exact: true }).first()
    if (!(await btn.count())) break
    await btn.click()
    await page.waitForTimeout(80)
  }
  await shot('04-party-equipped')

  await page.goto(BASE + '#/map')
  await page.waitForSelector('.map-node')
  await shot('05-map')
  await page.locator('.map-node', { hasText: 'Северный' }).click()
  await shot('06-map-route')
  await page.getByRole('button', { name: 'Отправиться' }).click()
  await page.getByRole('button', { name: /^Войти/ }).click()
  await page.waitForSelector('.numgrid')
  await page.locator('.numgrid button').nth(0).click()
  await shot('07-location')

  // бой из параграфа или произвольный
  const fight = page.locator('button.danger', { hasText: 'Бой:' }).first()
  if (await fight.count()) await fight.click()
  else {
    await page.getByRole('button', { name: 'Произвольный бой' }).click()
    await page.locator('.pick-row', { hasText: 'Орк' }).first().getByRole('button', { name: /^Больше/ }).click()
    await page.getByRole('button', { name: 'Начать бой' }).click()
  }
  await page.waitForSelector('text=Раунд')
  await shot('08-combat-start')
  for (let i = 0; i < 40; i++) {
    if (await page.getByRole('button', { name: 'Завершить бой' }).count()) break
    const monsters = page.getByRole('button', { name: 'Ход монстров' })
    if (await monsters.count()) { await monsters.click(); continue }
    const melee = page.getByRole('button', { name: 'Сойтись вплотную' })
    const attack = page.locator('button.primary', { hasText: /⚔|🏹/ }).first()
    if (await attack.count() && await attack.isEnabled()) { await attack.click(); continue }
    const skip = page.getByRole('button', { name: 'Пропустить' }).first()
    if (await melee.count() && !(await attack.count())) { await melee.click(); continue }
    if (await skip.count()) { await skip.click(); continue }
    break
  }
  await shot('09-combat-end')
  const finish = page.getByRole('button', { name: 'Завершить бой' })
  if (await finish.count()) await finish.click()

  await page.goto(BASE + '#/location/zolotoy-gorod?p=2'); await page.waitForSelector('.branch-head')
  // по этапам: выбор открывает ветку, бросок — свой исход
  await page.locator('.branch-head').first().click()
  await page.getByRole('button', { name: /Бросить к/ }).first().click()
  await page.getByRole('button', { name: /Брошено/ }).first().waitFor()
  await shot('09b-branches')

  await page.goto(BASE + '#/bestiary'); await page.waitForSelector('.thumb')
  await shot('10-bestiary')
  await page.locator('.card', { hasText: 'Василиск' }).first().click()
  await shot('11-bestiary-modal')
  await page.goto(BASE + '#/spells'); await shot('12-spells')
  await page.goto(BASE + '#/lore'); await page.waitForTimeout(300); await shot('13-lore')
  await page.goto(BASE + '#/rules'); await page.waitForTimeout(200); await shot('13b-rules')
  await page.goto(BASE + '#/location/zamok-chernogo-maga?p=13'); await shot('14-final')
  await page.goto(BASE); await shot('15-home-after')
  await ctx.close()
}

await run('desktop', { width: 1280, height: 800 })
await run('mobile', { width: 390, height: 844 }, true)
// телефон в альбомной ориентации: шапка уезжает при прокрутке, нижняя панель ниже
await run('landscape', { width: 844, height: 390 }, true)
await browser.close()
console.log(problems.length ? problems.join('\n') : 'Проблем не найдено')
