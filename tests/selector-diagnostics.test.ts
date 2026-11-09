import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { diagnoseSelectors, matchesDiagnosticPage } from '../src/hh/selector-diagnostics.js'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'
import { offerSelectorRepair } from '../src/hh/selector-repair.js'

const registry = new SelectorRegistry([parseSelectorGroup({ schemaVersion: 1, id: 'profile', selectors: {
  root: { kind: 'css', value: 'main', purpose: 'Profile', contract: { scope: '$page', cardinality: 'one', action: 'read' } },
  cards: { kind: 'css', value: 'article', purpose: 'Resume cards', contract: { scope: 'root', cardinality: 'many', action: 'read' } },
  resumeLink: { kind: 'css', value: 'a', purpose: 'Resume link', contract: { scope: 'cards', cardinality: 'one', action: 'read', reads: ['href', 'textContent'] } },
} })])

test('an existing response may have one view button in each alternative scope, but not two in one scope', async () => {
  const bundled = new SelectorRegistry(['vacancy', 'response-form', 'letter-form'].map(file =>
    parseSelectorGroup(JSON.parse(readFileSync(new URL(`../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8')))))
  const button = '<button data-qa="vacancy-response-link-view-topic">Открыть отклик</button>'
  for (const duplicate of [false, true]) {
    await offline(`<h1 data-qa="vacancy-title">Role</h1><div data-qa="vacancy-description">Tasks</div>
      <section class="vacancy-actions_magritte-vacancy-top">${button}</section>
      <section class="vacancy-actions_responded"><p>Резюме доставлено</p>${button}${duplicate ? button : ''}</section>`, async page => {
      const report = await diagnoseSelectors(page, 'VACANCY', bundled)
      const row = report.rows.find(item => item.key === 'viewResponse')!
      assert.equal(row.matched, duplicate ? 3 : 2)
      assert.equal(row.status, duplicate ? 'FAIL' : 'PASS')
      if (duplicate) {
        const offered = await offerSelectorRepair(page, report, bundled)
        assert.deepEqual(offered.repairableGroups, [])
        assert.match(offered.repairNote ?? '', /ИИ-починка пока недоступна/)
      }
    }, 'https://hh.ru/vacancy/123')
  }
})

test('access denied and unavailable vacancy pages skip diagnostics instead of reporting broken selectors', async () => {
  const bundled = new SelectorRegistry(['vacancy', 'response-form', 'letter-form'].map(file =>
    parseSelectorGroup(JSON.parse(readFileSync(new URL(`../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8')))))
  for (const message of ['Вам недоступна эта вакансия. Войдите как пользователь, у которого есть доступ на просмотр.', 'Вакансия не найдена']) {
    await offline(`<main><p>${message}</p></main>`, async page => {
      assert.equal(await page.locator('p').innerText(), message, 'Fixture must preserve its Cyrillic text')
      const report = await diagnoseSelectors(page, 'VACANCY', bundled)
      assert.equal(report.status, 'SKIPPED')
      assert.equal(report.summary, 'INCOMPLETE')
      assert.deepEqual(report.rows, [])
      assert.match(report.message, /не поломка селекторов/)
      const offered = await offerSelectorRepair(page, report, bundled)
      assert.deepEqual(offered.repairableGroups, [])
    }, 'https://hh.ru/vacancy/123')
  }
})

test('a required field with alternative scopes may be absent in one alternative, but not all', async () => {
  const custom = new SelectorRegistry([parseSelectorGroup({ schemaVersion: 1, id: 'profile', selectors: {
    left: { kind: 'css', value: '.left', purpose: 'Left', contract: { scope: '$page', cardinality: 'one', action: 'read' } },
    right: { kind: 'css', value: '.right', purpose: 'Right', contract: { scope: '$page', cardinality: 'one', action: 'read' } },
    target: { kind: 'css', value: '.target', purpose: 'Target', contract: { scope: { anyOf: ['left','right'] }, cardinality: 'one', action: 'read', required: true } },
  } })])
  // Keep the scopes visible even when the target is absent; empty divs have zero height in Playwright.
  for (const present of [true, false]) await offline(`<div class="left">Left scope</div><div class="right">Right scope ${present ? '<span class="target">Target</span>' : ''}</div>`, async page => {
    const report = await diagnoseSelectors(page, 'PROFILE', custom)
    assert.equal(report.rows.find(row => row.key === 'left')?.status, 'PASS')
    assert.equal(report.rows.find(row => row.key === 'right')?.status, 'PASS')
    assert.equal(report.rows.find(row => row.key === 'target')?.status, present ? 'PASS' : 'FAIL')
  })
})

async function offline(body: string, check: (page: Page) => Promise<void>, url = 'https://hh.ru/applicant/profile/me'): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }))
    await page.goto(url)
    await check(page)
  } finally { await browser.close() }
}

test('diagnostics validates cardinality per card and returns no personal values or clicks', async () => {
  const cards = ['a', 'b'].map(char => `<article><a href="/resume/${char.repeat(36)}">PRIVATE RESUME</a></article>`).join('')
  await offline(`<main>${cards}<button onclick="document.body.dataset.clicked='yes'">Send</button>
    <input value="PRIVATE INPUT"></main>`, async page => {
    const before = page.url()
    const report = await diagnoseSelectors(page, 'PROFILE', registry)
    assert.equal(report.status, 'CHECKED')
    assert.equal(report.rows.find(row => row.key === 'resumeLink')?.status, 'PASS')
    assert.equal(report.rows.find(row => row.key === 'resumeLink')?.matched, 2)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|aaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbb/)
    assert.equal(page.url(), before)
    assert.equal(await page.locator('body').getAttribute('data-clicked'), null)
  })
})

test('wrong links and duplicate required elements fail their structural checks', async () => {
  await offline('<main><article><a href="https://example.test/resume/abc">Wrong</a></article><article><a>A</a><a>B</a></article></main>', async page => {
    const report = await diagnoseSelectors(page, 'PROFILE', registry)
    assert.equal(report.rows.find(row => row.key === 'resumeLink')?.status, 'FAIL')
  })
})

test('login, CAPTCHA, wrong page and assessment do not create false selector failures', async () => {
  for (const [url, html, status] of [
    ['https://hh.ru/account/login?backUrl=/applicant/profile/me', '<main></main>', 'LOGIN'],
    ['https://hh.ru/applicant/profile/me', '<div data-qa="captcha">Manual check</div>', 'CAPTCHA'],
    ['https://assessment.hh.ru/applicant/profile/me', '<main></main>', 'WRONG_PAGE'],
    ['https://hh.ru/vacancy/123', '<main></main>', 'WRONG_PAGE'],
  ]) {
    await offline(html!, async page => {
      const report = await diagnoseSelectors(page, 'PROFILE', registry)
      assert.equal(report.status, status)
      assert.deepEqual(report.rows, [])
    }, url!)
  }
})

test('closed forms are not treated as broken selectors', async () => {
  const bundled = new SelectorRegistry(['vacancy', 'response-form', 'letter-form'].map(file =>
    parseSelectorGroup(JSON.parse(readFileSync(new URL(`../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8')))))
  await offline('<h1 data-qa="vacancy-title">Role</h1><div data-qa="vacancy-description">Tasks</div>', async page => {
    const report = await diagnoseSelectors(page, 'VACANCY', bundled)
    const forms = report.rows.filter(row => ['responseForm', 'letterForm'].includes(row.group))
    assert.ok(forms.length)
    assert.ok(forms.every(row => row.status === 'STATE_NOT_CHECKED'))
    assert.doesNotMatch(JSON.stringify(report), /Tasks/)
  }, 'https://hh.ru/vacancy/123')
})

test('resume diagnostics requires the print URL and ignores query noise for other pages', () => {
  assert.equal(matchesDiagnosticPage(`https://hh.ru/resume/${'a'.repeat(36)}`, 'RESUME'), false)
  assert.equal(matchesDiagnosticPage(`https://hh.ru/resume/${'a'.repeat(36)}?print=true`, 'RESUME'), true)
  assert.equal(matchesDiagnosticPage('https://hh.ru/search/vacancy?text=role', 'SEARCH'), true)
  assert.equal(matchesDiagnosticPage('https://hh.ru.evil.test/search/vacancy', 'SEARCH'), false)
})

test('profile resume link excludes the edit link even when both point to the same resume', async () => {
  const bundled = new SelectorRegistry([parseSelectorGroup(JSON.parse(readFileSync(
    new URL('../resources/hh-selectors/profile.json', import.meta.url), 'utf8')))])
  const hash = 'a'.repeat(36)
  await offline(`<div class="ResumeProfileFront-ReactRoot"><h2 data-qa="compact-resume-title">Resumes</h2>
    <div data-qa="resume" data-qa-id="1" data-qa-title="Role">
      <a data-qa="resume-card-link-${hash}" href="/resume/${hash}">View</a>
      <div data-qa="resume-title">Role</div><a data-qa="resume-button-edit-resume" href="/resume/${hash}">Edit</a>
    </div></div>`, async page => {
    const report = await diagnoseSelectors(page, 'PROFILE', bundled)
    const link = report.rows.find(row => row.key === 'resumeLink')
    assert.equal(link?.status, 'PASS')
    assert.equal(link?.matched, 1)
  })
})
