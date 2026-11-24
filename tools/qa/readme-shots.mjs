// Скриншоты для README: docs/img/home-desktop.jpg, docs/img/location-desktop.jpg и docs/img/mobile.jpg
// (четыре экрана телефона в ряд: главная, локация, бой, бестиарий).
// Запуск: pnpm dev --port 5177 (в другом терминале), затем `node tools/qa/readme-shots.mjs [url] [outDir]`.
// Снимать заново после заметных изменений интерфейса: README — витрина репозитория.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:5177/'
const OUT = process.argv[3] ?? 'docs/img'
mkdirSync(OUT, { recursive: true })
const DESKTOP = { width: 1280, height: 860 }
const PHONE = { width: 390, height: 800 }
const JPEG = { type: 'jpeg', quality: 86 }
const browser = await chromium.launch({ channel: 'chrome', headless: true })

/** партия быстрого старта в Золотом городе: прошла ворота и стоит в первом помещении */
async function start(viewport, touch = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(touch ? { isMobile: true, hasTouch: true } : {}) })
  const page = await ctx.newPage()
  await page.goto(BASE)
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE)
  await page.getByRole('button', { name: 'Быстрый старт' }).click()
  await page.waitForURL(/#\/map/)
  await page.getByRole('button', { name: /^Войти/ }).click()
  await page.waitForSelector('.exits button')
  await page.locator('.exits button').first().click()
  await page.waitForSelector('.loc-text h2')
  return { ctx, page }
}
const settle = (page) => page.waitForTimeout(400)

// ---------- компьютер ----------
{
  const { ctx, page } = await start(DESKTOP)
  // второе помещение — на плане два просвета в тумане
  await page.locator('.exits button').first().click()
  await settle(page)
  // план локации ниже первого экрана — снимок на всю высоту страницы
  await page.setViewportSize({ width: DESKTOP.width, height: await page.evaluate(() => document.documentElement.scrollHeight) })
  await page.screenshot({ path: `${OUT}/location-desktop.jpg`, ...JPEG })
  await page.setViewportSize(DESKTOP)
  await page.goto(BASE + '#/')
  await page.waitForSelector('.hero-cover')
  await settle(page)
  await page.screenshot({ path: `${OUT}/home-desktop.jpg`, ...JPEG })
  await ctx.close()
}

// ---------- телефон: четыре экрана в ряд ----------
{
  const { ctx, page } = await start(PHONE, true)
  const shots = []
  const shot = async () => { await settle(page); shots.push((await page.screenshot({ type: 'png' })).toString('base64')) }
  await page.goto(BASE + '#/')
  await page.waitForSelector('.hero-cover')
  await shot()
  await page.goto(BASE + '#/location/zolotoy-gorod')
  await page.waitForSelector('.loc-text h2')
  await shot()
  // бой из параграфа; нет кнопки боя в этом помещении — ищем в следующем
  for (let i = 0; i < 6; i++) {
    const fight = page.locator('button.danger', { hasText: 'Бой:' }).first()
    if (await fight.count() && await fight.isEnabled()) { await fight.click(); break }
    if (/#\/combat/.test(page.url()) || await page.getByRole('link', { name: 'На экран боя' }).count()) break
    await page.locator('.exits button').first().click()
    await settle(page)
  }
  if (!/#\/combat/.test(page.url())) await page.goto(BASE + '#/combat')
  await page.waitForSelector('text=Раунд')
  await shot()
  await page.goto(BASE + '#/bestiary')
  await page.waitForSelector('.thumb')
  await shot()
  await ctx.close()

  // склейка: страница с четырьмя снимками в ряд
  const gap = 14
  const sheet = await browser.newContext({ viewport: { width: PHONE.width * shots.length + gap * (shots.length + 1), height: PHONE.height + gap * 2 }, deviceScaleFactor: 1 })
  const p = await sheet.newPage()
  await p.setContent(`<body style="margin:0;background:#070a09;display:flex;gap:${gap}px;padding:${gap}px">${shots.map((s) => `<img src="data:image/png;base64,${s}" width="${PHONE.width}" height="${PHONE.height}" style="display:block;border-radius:18px;outline:1px solid #26362d">`).join('')}</body>`)
  await p.waitForFunction(() => [...document.images].every((i) => i.complete))
  await p.screenshot({ path: `${OUT}/mobile.jpg`, ...JPEG })
  await sheet.close()
}

await browser.close()
console.log(`Скриншоты для README — в ${OUT}`)
