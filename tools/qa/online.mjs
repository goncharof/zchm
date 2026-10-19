// Визуальный прогон сетевой игры: два игрока в одной комнате с (демо-)ИИ-ведущим.
// Нужны: pnpm dev (5177) и сервер на 8787: pnpm server (без ключей — сценарный ведущий)
// или pnpm exec tsx tools/qa/fake-gm-server.ts (демо-«ИИ»).
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
const code = (await host.page.locator('b', { hasText: /^[A-Z0-9]{5,8}$/ }).first().textContent()).trim()
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
await host.page.waitForFunction(() => /Демо-ведущий пересказывает|помещение 1/.test(document.body.innerText), null, { timeout: 8000 })
await host.shot('03-location-ai')
// сценарный ведущий: кнопки вариантов
const luckBtn = host.page.locator('.gm-msg button', { hasText: 'Проверка удачи' }).first()
if (await luckBtn.count()) {
  await luckBtn.click()
  await host.page.waitForFunction(() => document.body.innerText.includes('испытывает удачу'), null, { timeout: 5000 })
  const branch = guest.page.locator('.gm-msg button', { hasText: '▸' }).first()
  if (await branch.count()) { await branch.click(); await guest.page.waitForTimeout(400) }
  await host.shot('03b-choices')
}
await guest.page.waitForTimeout(400)
await guest.shot('03-location-ai')
await host.page.goto(BASE + '#/table')
await host.shot('04-table')

// текст книги игрокам не показывается
const leaked = await guest.page.evaluate(() => document.body.innerText.includes('§ 1'))
if (leaked) problems.push('[guest] виден номер параграфа с текстом книги')

// чат с любого экрана: гость на карте видит счётчик непрочитанного и открывает панель чата
await guest.page.goto(BASE + '#/map')
await host.page.locator('textarea').fill('Пётр, ты где?')
await host.page.locator('.composer .seg button', { hasText: 'Игрокам' }).click().catch(() => {})
await host.page.getByRole('button', { name: 'Отправить' }).click()
await guest.page.waitForTimeout(600)
const badge = await guest.page.locator('.tabbar .count, .icon-btn .count').first().textContent().catch(() => null)
if (!badge) problems.push('[guest] нет счётчика непрочитанного в чате')
await guest.page.getByRole('button', { name: 'Чат' }).first().click()
await guest.page.waitForSelector('.chat-panel .gm-chat-log')
if (!(await guest.page.locator('.chat-panel').innerText()).includes('Пётр, ты где?')) problems.push('[guest] реплика не видна в панели чата')
await guest.shot('05-chat-panel')

// обновление страницы: гость возвращается в ту же комнату
await guest.page.goto(BASE + '#/party')
await guest.page.reload()
await guest.page.waitForSelector('.room-chip', { timeout: 8000 }).catch(() => problems.push('[guest] после обновления страницы не вернулся в комнату'))
const chip = await guest.page.locator('.room-chip').first().textContent().catch(() => '')
if (chip && !chip.includes(code)) problems.push(`[guest] после обновления страницы другая комната: ${chip}`)
await browser.close()
console.log(problems.length ? problems.join('\n') : `Проблем не найдено (комната ${code})`)
