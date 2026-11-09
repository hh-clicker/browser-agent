import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { extractResumeText, readResumePrintText } from '../src/hh/resume-text.js'
import { readFileSync } from 'node:fs'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'

const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
// Synthetic fixtures use bundled selectors, never the installation's saved AI overrides.
const bundledRegistry = new SelectorRegistry([
  parseSelectorGroup(JSON.parse(readFileSync(new URL('../resources/hh-selectors/resume-text.json', import.meta.url), 'utf8'))),
])

test('print extraction uses configured XPath roots and professional blocks', async () => {
  const group = parseSelectorGroup(JSON.parse(readFileSync(new URL('../resources/hh-selectors/resume-text.json', import.meta.url), 'utf8')))
  group.selectors.root!.kind = 'xpath'; group.selectors.root!.value = '//article'
  group.selectors.ready!.kind = 'xpath'; group.selectors.ready!.value = './/h2'
  group.selectors.blocks!.kind = 'xpath'; group.selectors.blocks!.value = './/h2 | .//section'
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      '<main>Do not import this</main><article><h2>Backend</h2><section><p>Custom professional text.</p></section></article>' }))
    await page.goto(`https://hh.ru/resume/${hash}?print=true`)
    const text = await extractResumeText(page, hash, new SelectorRegistry([group]))
    assert.match(text, /Custom professional text/)
    assert.doesNotMatch(text, /Do not import/)
  } finally { await browser.close() }
})
// Synthetic fixture only. Never include a real applicant's resume or authentication state.
const fixture = `<!doctype html><html><body>
  <nav>Navigation noise</nav><main>
    <div data-qa="resume-block-contacts">private@example.test +000000</div>
    <h2 data-qa="resume-position">Backend Developer</h2>
    <div data-qa="resume-specializations">Full-time employment</div>
    <section data-qa="resume-experience-block"><h2>Experience</h2>
      <div>Example company</div><p>Built <strong>Java</strong> services &amp; APIs.</p>
      <ul><li>Maintained services</li><li>Improved tests</li></ul>
      <div style="white-space: pre-line">First paragraph\n\nSecond paragraph</div>
      <button>Show UI action</button><div hidden>Hidden noise</div>
      <script type="application/json">{"token":"secret"}</script>
      <img src="https://assets.example.test/photo.jpg" alt="Image noise">
    </section>
    <div data-qa="skills-table"><h2>Skills</h2><div>Java</div><div>SQL</div></div>
    <section data-qa="resume-about-block"><h2>About me</h2><p>Enjoy building reliable systems.</p></section>
    <section data-qa="resume-education-block"><h2>Education</h2><p>Example University</p></section>
    <div>Recommended courses noise</div>
  </main><footer>Footer noise</footer></body></html>`

test('print import keeps professional text and paragraphs, blocks images and closes its tab', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  try {
    const allowedRequests: string[] = []
    await context.route('**/*', route => {
      allowedRequests.push(route.request().url())
      return route.fulfill({ contentType: 'text/html', body: fixture })
    })
    const existing = await context.newPage()
    const text = await readResumePrintText(() => context.newPage(), hash, bundledRegistry)
    assert.match(text, /Built Java services & APIs\./)
    assert.match(text, /- Maintained services\n{1,2}- Improved tests/)
    assert.match(text, /First paragraph\n\nSecond paragraph/)
    assert.match(text, /Example University/)
    assert.doesNotMatch(text, /private@|\+000000|noise|secret|Show UI action|<[^>]+>/)
    assert.equal(allowedRequests.length, 1)
    assert.equal(context.pages().length, 1)
    assert.equal(context.pages()[0], existing)
  } finally { await browser.close() }
})

test('login redirect and changed resume identity are rejected without leaking page text', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main>private login data</main>' }))
    await assert.rejects(readResumePrintText(async () => {
      const page = await context.newPage()
      const goto = page.goto.bind(page)
      // Simulate the final redirect URL without an HTTP redirect escaping request routing.
      page.goto = (_url, options) => goto('https://hh.ru/account/login', options)
      return page
    }, hash, bundledRegistry), /Не удалось прочитать текст резюме/)
    assert.equal(context.pages().length, 0)
    const page = await context.newPage()
    await assert.rejects(extractResumeText(page, hash, bundledRegistry), /Resume URL changed/)
  } finally { await browser.close() }
})

test('title-only resume is imported without experience, education or minimum text length', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  try {
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
      body: '<main><h2 data-qa="resume-position">QA</h2></main>' }))
    assert.equal(await readResumePrintText(() => context.newPage(), hash, bundledRegistry), 'QA')
    assert.equal(context.pages().length, 0)
  } finally { await browser.close() }
})

test('genuinely empty or unexpectedly large text is rejected with a specific reason', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  try {
    let body = '<main><h2 data-qa="resume-position" style="min-height: 20px">&nbsp;</h2></main>'
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body }))
    await assert.rejects(readResumePrintText(() => context.newPage(), hash, bundledRegistry), /не содержат текста/)
    body = `<main><h2 data-qa="resume-position">Developer</h2><div data-qa="resume-about-block">${'x'.repeat(100001)}</div></main>`
    await assert.rejects(readResumePrintText(() => context.newPage(), hash, bundledRegistry), /100 000 символов/)
    assert.equal(context.pages().length, 0)
  } finally { await browser.close() }
})
