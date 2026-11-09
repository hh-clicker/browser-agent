import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'
import { readSearchCards, collectSearch } from '../src/hh/vacancy-search.js'
import { waitForStableSearch } from '../src/hh/search-stability.js'
import { diagnoseSelectors } from '../src/hh/selector-diagnostics.js'

function bundled(): SelectorRegistry {
  return new SelectorRegistry(['common', 'search'].map(name => parseSelectorGroup(JSON.parse(readFileSync(
    new URL(`../resources/hh-selectors/${name}.json`, import.meta.url), 'utf8')))))
}
async function offline(body: string, run: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }))
    await page.goto('https://hh.ru/search/vacancy')
    await run(page)
  } finally { await browser.close() }
}

test('search parser reads configured XPath card fields and allows a company without a link', async () => {
  const group = bundled().repairContext('search').group
  for (const [key, value] of Object.entries({ cards: '//article', title: './/h2/a', employerName: './/strong' })) {
    group.selectors[key]!.kind = 'xpath'; group.selectors[key]!.value = value
  }
  await offline('<article><h2><a href="/vacancy/123">Custom role</a></h2><strong>Company without link</strong></article>'
    + '<template id="HH-Lux-InitialState">{}</template>', async page => {
    const cards = await readSearchCards(page, new SelectorRegistry([group]))
    assert.equal(cards[0]?.hhVacancyId, '123')
    assert.equal(cards[0]?.companyName, 'Company without link')
    assert.equal(cards[0]?.employerId, null)
  })
})

test('missing optional fields warn only when independent visible evidence exists and never stop card collection', async () => {
  for (const visibleFields of ['', '<p>От 200 000 ₽ за месяц</p><p>Опыт 3–6 лет</p><p>Удалённо</p>']) {
    const registry = bundled()
    const warnings: import('../src/hh/selector-diagnostics.js').SelectorDiagnosticReport[] = []
    await offline('<article data-qa="vacancy-serp__vacancy"><a data-qa="serp-item__title" href="/vacancy/123">Role</a>'
      + '<span data-qa="vacancy-serp__vacancy-employer-text">Company</span>' + visibleFields + '</article>', async page => {
      const cards = await readSearchCards(page, registry, report => warnings.push(report))
      assert.equal(cards.length, 1)
      assert.equal(warnings.length, visibleFields ? 1 : 0)
      if (visibleFields) {
        assert.deepEqual(warnings[0]!.rows.map(row => row.key).sort(), ['experience', 'remote', 'salarySpan'])
        assert.ok(warnings[0]!.rows.every(row => !row.required))
        assert.doesNotMatch(JSON.stringify(warnings), /200 000|Company/)
        const diagnostic = await diagnoseSelectors(page, 'SEARCH', registry)
        assert.equal(diagnostic.rows.find(row => row.key === 'experience')?.status, 'FAIL')
      }
    })
  }
})

test('pagination can retain the warning page while collecting later pages in another tab', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    await context.route('**/*', route => {
      const index = Number(new URL(route.request().url()).searchParams.get('page') ?? 0)
      const body = '<button data-qa="applicantProfileDesktopDrop-button">Account</button>'
        + `<article data-qa="vacancy-serp__vacancy"><a data-qa="serp-item__title" href="/vacancy/${123 + index}">Role</a>`
        + '<span data-qa="vacancy-serp__vacancy-employer-text">Company</span>'
        + (index === 0 ? '<p>Удалённо</p>' : '') + '</article>'
        + `<nav data-qa="pager-block"><a aria-current="page" href="/search/vacancy?page=${index}">${index + 1}</a>`
        + (index === 0 ? '<a href="/search/vacancy?page=1">Next</a>' : '') + '</nav>'
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body })
    })
    const original = await context.newPage()
    let continuations = 0
    let warningCount = 0
    const cards = await collectSearch(original, 'https://hh.ru/search/vacancy', 2, undefined, bundled(),
      () => { warningCount++ }, async page => {
        continuations++
        assert.equal(page, original)
        return context.newPage()
      })
    assert.deepEqual(cards.map(card => card.hhVacancyId), ['123', '124'])
    assert.equal(continuations, 1)
    assert.equal(warningCount, 1)
    assert.equal(new URL(original.url()).searchParams.get('page'), '0')
    assert.equal(original.isClosed(), false)
    assert.equal(context.pages().length, 2)
  } finally { await browser.close() }
})

test('search stability resets when card contents change during hydration', async () => {
  await offline('<article data-qa="vacancy-serp__vacancy">Loading</article>', async page => {
    await page.evaluate(() => {
      setTimeout(() => { document.querySelector('article')!.textContent = 'Complete' }, 60)
    })
    assert.equal(await waitForStableSearch(page, bundled(), { intervalMs: 20, stableSamples: 5, timeoutMs: 2000 }), 'STABLE')
    assert.equal(await page.locator('article').innerText(), 'Complete')
  })
})

test('search diagnostics waits for later cards and treats only the employer link as optional', async () => {
  const card = '<article data-qa="vacancy-serp__vacancy"><a data-qa="serp-item__title" href="/vacancy/123">Role</a>'
    + '<span data-qa="vacancy-serp__vacancy-employer-text">Company</span></article>'
  await offline('<button data-qa="applicantProfileDesktopDrop-button">Account</button>' + card, async page => {
    await page.evaluate(html => { setTimeout(() => { document.body.insertAdjacentHTML('beforeend', html) }, 60) },
      card.replace('/123', '/124').replace('</article>', '<a data-qa="vacancy-serp__vacancy-employer" href="/employer/1">Company</a></article>'))
    const result = await diagnoseSelectors(page, 'SEARCH', bundled())
    assert.equal(result.rows.find(row => row.key === 'cards')?.matched, 2)
    assert.equal(result.rows.find(row => row.key === 'title')?.matched, 2)
    assert.equal(result.rows.find(row => row.key === 'employerName')?.matched, 2)
    assert.equal(result.rows.find(row => row.key === 'employerLink')?.status, 'PASS')
    assert.equal(result.rows.find(row => row.key === 'employerLink')?.matched, 1)
    await page.locator('[data-qa="vacancy-serp__vacancy-employer-text"]').first().evaluate(node => node.remove())
    const broken = await diagnoseSelectors(page, 'SEARCH', bundled())
    assert.equal(broken.rows.find(row => row.key === 'employerName')?.status, 'FAIL')
  })
})
