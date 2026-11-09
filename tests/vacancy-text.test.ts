import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, type Page } from 'playwright'
import { extractVacancyText as extract } from '../src/hh/vacancy-text.js'
import { bundledSelectors } from './helpers/bundled-selectors.js'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'
const bundled = bundledSelectors()
const extractVacancyText: typeof extract = (page, id, registry = bundled) => extract(page, id, registry)

// Synthetic equivalents of ordinary and branded markup. No copied HH assets or user data.
const description = `<div data-qa="vacancy-description">
  <p>Build <strong>Java</strong> services &amp; APIs.</p>
  <p><strong>Tasks</strong></p><ul><li>Develop features</li><li>Review code</li></ul>
  <div>First line<br><span>Second line</span></div>
  <pre>One\n\nTwo</pre><p>Read <a href="https://example.test">documentation</a>.</p>
  <img src="https://example.test/banner.png" alt="Image noise">
  <svg><text>SVG noise</text></svg><button>Button noise</button>
  <script type="application/json">{"secret":"noise"}</script><style>.unused{color:red}</style>
  <div hidden>Hidden noise</div><p style="display:none">Hidden noise</p>
  <p aria-hidden="true">Hidden noise</p><p style="visibility:hidden">Hidden noise</p>
</div>`

async function offline(body: string, check: (page: Page, requests: string[]) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const requests: string[] = []
    await context.route('**/*', route => {
      requests.push(route.request().url())
      return route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` })
        : route.abort()
    })
    const page = await context.newPage()
    await page.goto('https://hh.ru/vacancy/123')
    await check(page, requests)
  } finally { await browser.close() }
}

test('configured description XPath preserves vacancy identity and recommendation exclusions', async () => {
  const registry = new SelectorRegistry([parseSelectorGroup({ schemaVersion: 1, id: 'vacancy', selectors: {
    description: { kind: 'xpath', value: '//section[@class="job-text"]', purpose: 'Employer description' },
  } })])
  await offline(`<section class="job-text"><p>Build services.</p><button>Ignore</button></section>
    <aside data-qa="vacancy-view-vacancies-from-search"><section class="job-text">Other vacancy</section></aside>`, async page => {
    assert.equal(await extractVacancyText(page, '123', registry), 'Build services.')
    assert.equal(await extractVacancyText(page, '999', registry), null)
  })
})

for (const branded of [false, true]) {
  test(`${branded ? 'branded' : 'ordinary'} description keeps paragraphs and lists, without template or image text`, async () => {
    const content = branded
      ? `<div class="vacancy-description-print"><div class="vacancy-branded-description-content"><p>Brand noise</p>${description}<p>Benefits outside description noise</p></div></div>`
      : description
    await offline(`<nav>Navigation noise</nav>${content}<div data-qa="skills-element">Skill noise</div>
      <div hidden>${description}</div><div data-qa="vacancy-view-vacancies-from-search">${description}</div>`, async (page, requests) => {
      const countBefore = requests.length
      const text = await extractVacancyText(page, '123')
      assert.ok(text)
      assert.match(text, /Build Java services & APIs\./)
      assert.match(text, /- Develop features\n{1,2}- Review code/)
      assert.match(text, /First line\nSecond line/)
      assert.match(text, /One\n\nTwo/)
      assert.match(text, /Read documentation\./)
      assert.doesNotMatch(text, /noise|secret|https:|<[^>]+>/)
      assert.equal(requests.length, countBefore, 'extraction must not make network requests')
    })
  })
}

test('image-only or empty description is captured as empty, not a failure', async () => {
  for (const content of ['<img alt="Do not turn alt into description">', '&nbsp;']) {
    await offline(`<div data-qa="vacancy-description">${content}</div>`, async page => {
      assert.equal(await extractVacancyText(page, '123'), '')
    })
  }
})

test('missing, ambiguous, oversized or wrong-vacancy content is not captured', async () => {
  for (const content of ['<p>Missing description</p>', description + description,
    `<div data-qa="vacancy-description">${'x'.repeat(100001)}</div>`]) {
    await offline(content, async page => {
      assert.equal(await extractVacancyText(page, '123'), null)
    })
  }
  await offline(description, async page => {
    assert.equal(await extractVacancyText(page, '999'), null)
    await page.goto('https://hh.ru/account/login')
    assert.equal(await extractVacancyText(page, '123'), null)
  })
})
