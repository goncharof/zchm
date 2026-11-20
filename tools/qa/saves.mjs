// Визуальный прогон сохранений: метка «сохранено», окно «Сохранения», «Отложить игру», «Недавние комнаты».
// Нужны: pnpm dev и сервер на 8787 (pnpm server). Запуск: node tools/qa/saves.mjs [url] [outDir]
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
const BASE = process.argv[2] ?? 'http://localhost:5177/'
const OUT = process.argv[3] ?? 'tools/qa/out'
mkdirSync(OUT, { recursive: true })
const problems = []
const check = (ok, what) => { if (!ok) problems.push(what); console.log(`${ok ? '✓' : '✗'} ${what}`) }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
async function player(label, viewport) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()}`) })
  // подтверждения («Покинуть комнату?», «Перезаписать слот?») принимаются
  page.on('dialog', (d) => void d.accept())
  await page.goto(BASE)
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE)
  const shot = async (name) => {
    await page.waitForTimeout(300)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    if (wide) problems.push(`[${label}] горизонтальная прокрутка: ${name}`)
    await page.screenshot({ path: `${OUT}/saves-${label}-${name}.png`, fullPage: true })
  }
  return { page, shot, ctx, label }
}
const text = (p) => p.evaluate(() => document.body.innerText)
/** открыть «Сохранения»: метка в верхней панели */
const openSaves = async (p) => { await p.getByRole('button', { name: 'Сохранения', exact: true }).first().click(); await p.getByRole('dialog', { name: 'Сохранения' }).waitFor() }

// ---------- одиночная игра ----------
for (const [label, viewport] of [['solo-desktop', { width: 1280, height: 860 }], ['solo-mobile', { width: 390, height: 844 }], ['solo-landscape', { width: 844, height: 390 }]]) {
  const a = await player(label, viewport)
  await a.page.getByRole('button', { name: 'Быстрый старт' }).click()
  await a.page.waitForURL(/#\/map/)
  await a.page.waitForTimeout(400)
  check(await a.page.locator('.save-chip').isVisible(), `[${label}] метка сохранения видна на карте`)
  await a.shot('01-map-chip')
  await openSaves(a.page)
  check(/Игра сохраняется сама в этом браузере/.test(await text(a.page)), `[${label}] окно объясняет автосохранение`)
  await a.page.getByRole('button', { name: 'Сохранить в слот 1' }).click()
  await a.shot('02-dialog')
  check(/Слот 1\s*День 1/.test(await text(a.page)), `[${label}] слот 1 занят`)
  await a.page.keyboard.press('Escape')
  await a.page.goto(BASE + '#/')
  await a.shot('03-home')
  // закрыли вкладку и открыли снова: партия на месте
  await a.page.reload()
  check(await a.page.getByRole('button', { name: /Продолжить/ }).isVisible(), `[${label}] после перезагрузки есть «Продолжить»`)
  await a.ctx.close()
}

// ---------- сетевая игра ----------
const host = await player('host', { width: 1280, height: 860 })
const guest = await player('guest', { width: Number(process.env.GUEST_W ?? 390), height: 844 })
await host.page.getByPlaceholder('Например, Иван').fill('Иван')
await host.page.getByRole('button', { name: 'Создать комнату' }).click()
await host.page.waitForURL(/#\/table/)
const code = (await host.page.locator('.room-chip').first().textContent()).trim().slice(0, 6)
console.log('комната', code)

// гость входит по ссылке: код подставлен
await guest.page.goto(`${BASE}#/?room=${code}`)
await guest.page.reload()
check((await guest.page.getByPlaceholder('Код комнаты').inputValue()) === code, '[guest] ссылка подставляет код комнаты')
await guest.page.getByPlaceholder('Например, Иван').fill('Пётр')
await guest.page.getByRole('button', { name: 'Войти', exact: true }).click()
await guest.page.waitForURL(/#\/table/)

await host.page.goto(BASE + '#/')
await host.page.getByRole('button', { name: 'Быстрый старт' }).click()
await host.page.waitForURL(/#\/map/)
await guest.page.goto(BASE + '#/party')
await guest.page.getByRole('button', { name: 'Взять героя' }).nth(1).click()
await host.page.goto(BASE + '#/party'); await host.page.getByRole('button', { name: 'Взять героя' }).first().click()
await guest.page.waitForTimeout(400)

// окно «Сохранения» в сетевой игре
check(await host.page.locator('.save-chip').isVisible(), '[host] метка сохранения видна')
await openSaves(host.page)
check(new RegExp(`Партия комнаты\\s*${code}\\s*хранится на сервере`).test(await text(host.page)), '[host] окно объясняет: партия на сервере')
check(await host.page.getByRole('button', { name: 'Загрузить из файла' }).isVisible(), '[host] хозяин может загрузить файл')
await host.shot('01-dialog')
await host.page.keyboard.press('Escape')
await guest.page.locator('.tabbar button', { hasText: 'Ещё' }).click()
await guest.shot('01-more-sheet')
await guest.page.locator('.sheet button', { hasText: 'Сохранения' }).click()
await guest.page.getByRole('dialog', { name: 'Сохранения' }).waitFor()
check(!(await guest.page.getByRole('button', { name: 'Загрузить из файла' }).count()), '[guest] гость не может загрузить файл')
await guest.shot('02-dialog')

// гость откладывает игру: герой остаётся за ним
await guest.page.getByRole('dialog').getByRole('button', { name: 'Отложить игру' }).click()
await guest.page.waitForURL(/#\/$/)
await guest.page.waitForTimeout(500)
await guest.shot('03-home-suspended')
check(await guest.page.getByRole('button', { name: /Вернуться за стол/ }).isVisible(), '[guest] на главной есть «Вернуться за стол»')
check(/Недавние комнаты/.test(await text(guest.page)), '[guest] список недавних комнат')
await host.page.goto(BASE + '#/')
await host.page.waitForTimeout(400)
const row = await host.page.locator('table.list tr', { hasText: 'Пётр' }).innerText()
check(!/без героя/.test(row), `[host] герой отложившего игрока остался за ним: ${row.replace(/\s+/g, ' ')}`)
await host.shot('02-home-room')

// обновление страницы после «Отложить» не возвращает в комнату само, а кнопка возвращает
await guest.page.reload()
await guest.page.waitForTimeout(600)
check(!(await guest.page.locator('.room-chip').count()), '[guest] после «Отложить» страница не входит в комнату сама')
await guest.page.getByRole('button', { name: /Вернуться за стол/ }).click()
await guest.page.waitForURL(/#\/table/)
await guest.page.goto(BASE + '#/party')
await guest.page.waitForTimeout(400)
check(await guest.page.getByRole('button', { name: /Отпустить|Освободить/ }).count() > 0 || /вы/.test(await text(guest.page)), '[guest] вернулся к своему герою')
await guest.shot('04-party-back')

// хозяин откладывает и возвращается хозяином
await host.page.locator('#online').getByRole('button', { name: 'Отложить игру' }).click()
await host.page.waitForTimeout(500)
await host.shot('03-home-suspended')
await host.page.locator('.recent-row', { hasText: code }).getByRole('button', { name: 'Вернуться' }).click()
await host.page.waitForURL(/#\/table/)
await host.page.goto(BASE + '#/')
await host.page.waitForTimeout(400)
check(await host.page.locator('table.list tr', { hasText: 'Иван' }).locator('.badge', { hasText: 'хозяин' }).count() === 1, '[host] вернулся хозяином')

// гость покидает комнату насовсем: комнаты нет в недавних, герой свободен
await guest.page.goto(BASE + '#/')
await guest.page.locator('#online').getByRole('button', { name: 'Покинуть комнату' }).click()
await guest.page.waitForTimeout(600)
check(!/Недавние комнаты/.test(await text(guest.page)), '[guest] покинутая комната пропала из недавних')
await guest.shot('05-home-left')
await host.page.waitForTimeout(300)
check(!(await host.page.locator('table.list tr', { hasText: 'Пётр' }).count()), '[host] покинувший игрок ушёл из комнаты')

await browser.close()
console.log(problems.length ? `\nПроблемы:\n- ${problems.join('\n- ')}` : '\nПроблем нет')
process.exit(problems.length ? 1 : 0)
