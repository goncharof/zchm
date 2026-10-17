// Визуальный прогон сетевой игры: два игрока в одной комнате с (демо-)ИИ-ведущим.
// Нужны: pnpm dev (5177) и pnpm exec tsx tools/qa/fake-gm-server.ts (8787).
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
const BASE = process.argv[2] ?? 'http://localhost:5177/'
const OUT = process.argv[3] ?? 'tools/qa/out'
mkdirSync(OUT, { recursive: true })
const problems = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
async function player(label, viewport) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()}`) })
  await page.goto(BASE)
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE)
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/online-${label}-${name}.png`, fullPage: true }) }
  return { page, shot, ctx }
}
const host = await player('host', { width: 1280, height: 860 })
const guest = await player('guest', { width: 390, height: 844 })

// хозяин создаёт комнату с ИИ-ведущим
await host.page.getByPlaceholder('Например, Иван').fill('Иван')
await host.page.locator('select').filter({ hasText: 'ИИ-ведущий' }).selectOption('ai')
await host.page.getByRole('button', { name: 'Создать комнату' }).click()
await host.page.waitForURL(/#\/table/)
const code = (await host.page.locator('b', { hasText: /^[A-Z0-9]{5}$/ }).first().textContent()).trim()
await host.shot('01-table-empty')

// второй игрок входит по коду
await guest.page.getByPlaceholder('Например, Иван').fill('Пётр')
await guest.page.getByPlaceholder('Код комнаты').fill(code)
await guest.page.getByRole('button', { name: 'Войти', exact: true }).click()
await guest.page.waitForURL(/#\/table/)

// хозяин собирает партию, гость берёт героя
await host.page.goto(BASE + '#/')
await host.page.getByRole('button', { name: 'Быстрый старт' }).click()
await host.page.waitForURL(/#\/map/)
await guest.page.goto(BASE + '#/party')
await guest.page.getByRole('button', { name: 'Взять героя' }).nth(1).click()
await host.page.goto(BASE + '#/party'); await host.page.getByRole('button', { name: 'Взять героя' }).first().click(); await host.page.goto(BASE + '#/map')
await guest.page.waitForTimeout(300)
await guest.shot('02-party')

// партия входит в Золотой город, гость идёт в помещение 1
await host.page.getByRole('button', { name: /^Войти/ }).click()
await host.page.waitForURL(/#\/location/)
await host.page.waitForTimeout(800)
await guest.page.goto(BASE + '#/location/zolotoy-gorod')
await guest.page.locator('.numgrid button').first().click()
await host.page.waitForFunction(() => document.body.innerText.includes('Демо-ведущий пересказывает'), null, { timeout: 8000 })
await host.shot('03-location-ai')
await guest.page.waitForTimeout(400)
await guest.shot('03-location-ai')
await host.page.goto(BASE + '#/table')
await host.shot('04-table')

// текст книги игрокам не показывается
const leaked = await guest.page.evaluate(() => document.body.innerText.includes('§ 1'))
if (leaked) problems.push('[guest] виден номер параграфа с текстом книги')
await browser.close()
console.log(problems.length ? problems.join('\n') : `Проблем не найдено (комната ${code})`)
