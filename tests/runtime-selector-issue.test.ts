import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Page } from 'playwright'
import { runtimeSelectorIssue as inspect } from '../src/hh/runtime-selector-issue.js'
import { bundledSelectors } from './helpers/bundled-selectors.js'

const bundled = bundledSelectors()
const runtimeSelectorIssue = (page: Page) => inspect(page, bundled)

async function offline(body: string, url: string, status: number, run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body }))
    await page.goto(url)
    await run(page)
  } finally { await browser.close() }
}
test('loaded broken vacancy yields structural context but no extracted personal values', async () => {
  await offline('<main><p>PRIVATE PAGE TEXT</p></main>', 'https://hh.ru/vacancy/123', 200, async page => {
    const report = await runtimeSelectorIssue(page)
    assert.equal(report?.pageType, 'VACANCY')
    assert.ok(report?.rows.some(row => row.key === 'title' && row.status === 'FAIL'))
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE PAGE TEXT/)
  })
})

test('pending secondary resources do not suppress a profile parsing failure after DOMContentLoaded', async () => {
  const browser = await chromium.launch({ headless: true })
  let releaseImage: (() => void) | undefined
  const imagePending = new Promise<void>(resolve => { releaseImage = resolve })
  try {
    const page = await browser.newPage()
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).pathname === '/slow-image.png') {
        await imagePending
        await route.abort().catch(() => undefined)
      } else await route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: '<main><p>Loaded profile with broken required elements</p><img src="/slow-image.png"></main>' })
    })
    await page.goto('https://hh.ru/applicant/profile/me', { waitUntil: 'domcontentloaded' })
    assert.equal(await page.evaluate(() => document.readyState), 'interactive')
    const report = await runtimeSelectorIssue(page)
    assert.equal(report?.pageType, 'PROFILE')
    assert.equal(report?.summary, 'FAILED')
  } finally { releaseImage?.(); await browser.close() }
})
test('login, CAPTCHA, access restrictions, HTTP failure and obstructing advice are not selector issues', async () => {
  for (const [body, url, status] of [
    ['<p>Login</p>', 'https://hh.ru/account/login', 200],
    ['<p>Подтвердите, что вы не робот</p>', 'https://hh.ru/vacancy/123', 200],
    ['<p>Вам недоступна эта вакансия</p>', 'https://hh.ru/vacancy/123', 200],
    ['<p>Вакансия не найдена</p>', 'https://hh.ru/vacancy/123', 200],
    ['<p>Server error</p>', 'https://hh.ru/vacancy/123', 503],
    ['<div role="dialog">Добавьте фото в резюме</div>', 'https://hh.ru/vacancy/123', 200],
  ] as const) await offline(body, url, status, async page => assert.equal(await runtimeSelectorIssue(page), null))
})
