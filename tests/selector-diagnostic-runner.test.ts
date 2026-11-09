import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { runFullSelectorDiagnostics } from '../src/hh/selector-diagnostic-runner.js'
import { diagnoseSelectors } from '../src/hh/selector-diagnostics.js'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'

function bundled(breakProfile = false, breakLetter = false): SelectorRegistry {
  return new SelectorRegistry(['profile','common','search','vacancy','response-form','letter-form','resume-text'].map(file => {
    const data = parseSelectorGroup(JSON.parse(readFileSync(new URL(`../resources/hh-selectors/${file}.json`, import.meta.url),'utf8')))
    if (breakProfile && data.id === 'profile') data.selectors.resumeLink!.value = 'a.does-not-exist'
    if (breakLetter && data.id === 'letterForm') data.selectors.form!.value = 'form.does-not-exist'
    return data
  }))
}
const hash = 'a'.repeat(36)
const profile = `<div class="ResumeProfileFront-ReactRoot"><h2 data-qa="compact-resume-title">Resumes</h2>
  <div data-qa="resume" data-qa-id="1" data-qa-title="PRIVATE ROLE"><a data-qa="resume-card-link-${hash}" href="/resume/${hash}">Open</a>
  <div data-qa="resume-title">PRIVATE ROLE</div></div></div>`
const resume = '<main><h1 data-qa="resume-position">PRIVATE ROLE</h1><div data-qa="resume-experience-block">PRIVATE EXPERIENCE</div></main>'
const search = `<article data-qa="vacancy-serp__vacancy"><a data-qa="serp-item__title" href="/vacancy/123">PRIVATE VACANCY</a>
  <a data-qa="vacancy-serp__vacancy-employer" href="/employer/1"><span data-qa="vacancy-serp__vacancy-employer-text">PRIVATE COMPANY</span></a>
  <div class="compensation-labels--test"><span><data value="100">100</data><data value="RUB">RUB</data></span></div></article>
  <nav data-qa="pager-block"><a href="/search/vacancy?page=0"><span aria-current="page">1</span></a></nav>
  <template id="HH-Lux-InitialState">{"data":true}</template>`
const vacancy = '<h1 data-qa="vacancy-title">PRIVATE VACANCY</h1><div data-qa="vacancy-description">PRIVATE TASKS</div>'
  + '<div class="vacancy-actions_magritte-vacancy-top"><a data-qa="vacancy-response-link-top" href="/applicant/vacancy_response?vacancyId=123">Respond</a></div>'

async function offline(check: (create: () => Promise<Page>, visited: string[], retained: Page[]) => Promise<void>, empty = false): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const visited: string[] = []
    const retained: Page[] = []
    await context.route('**/*', route => {
      const path = new URL(route.request().url()).pathname
      visited.push(path)
      const body = path === '/applicant/profile/me' ? profile : path.startsWith('/resume/') ? resume
        : path === '/search/vacancy' ? empty ? '<p>По вашему запросу ничего не найдено</p>' : search : vacancy
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body })
    })
    await check(() => context.newPage(), visited, retained)
  } finally { await browser.close() }
}

test('full diagnostic uses the search result vacancy and closes successful tabs without sending anything', async () => {
  await offline(async (createPage, visited, retained) => {
    const pages: Page[] = []
    const report = await runFullSelectorDiagnostics({ hhResumeId: hash, searchUrl: 'https://hh.ru/search/vacancy?text=role', searchName: 'Saved search' }, {
      createPage: async () => { const page = await createPage(); pages.push(page); return page },
      retainPage: page => { retained.push(page); return 'retained' },
    }, bundled())
    assert.equal(report.summary, 'PASSED')
    assert.deepEqual(report.scenarios?.map(item => item.pageType), ['PROFILE','RESUME','SEARCH','VACANCY'])
    assert.deepEqual(visited, ['/applicant/profile/me', `/resume/${hash}`, '/search/vacancy', '/vacancy/123'])
    assert.ok(pages.every(page => page.isClosed()))
    assert.equal(retained.length, 0)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|aaaaaaaaaaaaaaaaaaaa/)
  })
})

test('a broken profile retains its diagnostic tab and skips dependent resume extraction', async () => {
  await offline(async (createPage, _visited, retained) => {
    const report = await runFullSelectorDiagnostics({ hhResumeId: hash, searchUrl: null, searchName: null }, {
      createPage, retainPage: page => { retained.push(page); return 'retained' },
    }, bundled(true))
    assert.equal(report.summary, 'FAILED')
    assert.equal(report.scenarios?.[1]?.status, 'BLOCKED')
    assert.equal(report.scenarios?.[1]?.summary, 'FAILED')
    assert.match(report.scenarios?.[1]?.message ?? '', /profile\.resumeLink/)
    assert.equal(report.scenarios?.[0]?.tabId, 'retained')
    assert.equal(retained.length, 1)
    assert.equal(retained[0]?.isClosed(), false)
  })
})

test('an empty search passes as an empty result but leaves vacancy coverage incomplete', async () => {
  await offline(async (createPage, _visited, retained) => {
    const report = await runFullSelectorDiagnostics({ hhResumeId: hash, searchUrl: 'https://hh.ru/search/vacancy', searchName: null }, {
      createPage, retainPage: page => { retained.push(page); return 'retained' },
    }, bundled())
    assert.equal(report.scenarios?.[2]?.summary, 'PASSED', JSON.stringify(report.scenarios?.[2]))
    assert.equal(report.scenarios?.[3]?.status, 'SKIPPED')
    assert.equal(report.summary, 'INCOMPLETE')
  }, true)
})

test('profile repair opens only the blocked resume and preserves the independent search report', async () => {
  await offline(async (createPage, visited, retained) => {
    const target = { hhResumeId: hash, searchUrl: 'https://hh.ru/search/vacancy?text=role', searchName: 'Saved search' }
    const ports = { createPage, retainPage: (page: Page) => { retained.push(page); return `retained-${retained.length}` } }
    const previous = await runFullSelectorDiagnostics(target, ports, bundled(true))
    assert.equal(previous.scenarios?.[1]?.status, 'BLOCKED')
    const page = retained[0]!
    const repaired = await diagnoseSelectors(page, 'PROFILE', bundled())
    repaired.tabId = previous.scenarios![0]!.tabId!
    const beforeVisits = visited.length
    const continued = await runFullSelectorDiagnostics(target, ports, bundled(), { previous, repaired, page })
    assert.deepEqual(visited.slice(beforeVisits), [`/resume/${hash}`])
    assert.deepEqual(continued.scenarios?.[2], previous.scenarios?.[2])
    assert.deepEqual(continued.scenarios?.[3], previous.scenarios?.[3])
    assert.equal(continued.scenarios?.[1]?.summary, 'PASSED')
    assert.equal(previous.scenarios?.[1]?.status, 'BLOCKED')
    assert.equal(continued.summary, 'PASSED')
  })
})

test('search repair opens only the blocked vacancy and retains earlier profile and resume snapshots', async () => {
  await offline(async (createPage, visited, retained) => {
    const target = { hhResumeId: hash, searchUrl: 'https://hh.ru/search/vacancy?text=role', searchName: 'Saved search' }
    const ports = { createPage, retainPage: (page: Page) => { retained.push(page); return `retained-${retained.length}` } }
    const broken = bundled().previewOverride('search', { title: { kind: 'css', value: 'a.missing-title', purpose: 'Title' } })
    const previous = await runFullSelectorDiagnostics(target, ports, broken)
    assert.equal(previous.scenarios?.[3]?.status, 'BLOCKED')
    const page = retained[0]!
    const repaired = await diagnoseSelectors(page, 'SEARCH', bundled())
    repaired.tabId = previous.scenarios![2]!.tabId!
    const beforeVisits = visited.length
    const continued = await runFullSelectorDiagnostics(target, ports, bundled(), { previous, repaired, page })
    assert.deepEqual(visited.slice(beforeVisits), ['/vacancy/123'])
    assert.deepEqual(continued.scenarios?.[0], previous.scenarios?.[0])
    assert.deepEqual(continued.scenarios?.[1], previous.scenarios?.[1])
    assert.equal(continued.scenarios?.[2]?.contextLabel, 'Saved search')
    assert.equal(continued.scenarios?.[3]?.summary, 'PASSED')
    assert.equal(continued.summary, 'PASSED')
  })
})

test('a newly unblocked broken resume is retained for its own repair, not silently marked successful', async () => {
  await offline(async (createPage, visited, retained) => {
    const target = { hhResumeId: hash, searchUrl: null, searchName: null }
    const ports = { createPage, retainPage: (page: Page) => { retained.push(page); return `retained-${retained.length}` } }
    const previous = await runFullSelectorDiagnostics(target, ports, bundled(true))
    const page = retained[0]!
    const repaired = await diagnoseSelectors(page, 'PROFILE', bundled())
    repaired.tabId = previous.scenarios![0]!.tabId!
    const brokenResume = bundled().previewOverride('resumeText', { ready: { kind: 'css', value: '.missing-position', purpose: 'Position' } })
    const continued = await runFullSelectorDiagnostics(target, ports, brokenResume, { previous, repaired, page })
    const resumeStep = continued.scenarios![1]!
    assert.equal(resumeStep.summary, 'FAILED')
    assert.deepEqual(resumeStep.repairableGroups, ['resumeText'])
    assert.ok(resumeStep.tabId)
    assert.equal(continued.summary, 'FAILED')
    assert.deepEqual(visited.filter(path => path === '/applicant/profile/me'), ['/applicant/profile/me'])
    const resumePage = retained[1]!
    const fixedResume = await diagnoseSelectors(resumePage, 'RESUME', bundled())
    fixedResume.tabId = resumeStep.tabId!
    const beforeSecondRepair = visited.length
    const final = await runFullSelectorDiagnostics(target, ports, bundled(), { previous: continued, repaired: fixedResume, page: resumePage })
    assert.equal(visited.length, beforeSecondRepair)
    assert.equal(final.scenarios?.[1]?.summary, 'PASSED')
    assert.deepEqual(final.scenarios?.[0], continued.scenarios?.[0])
  })
})

test('current mode detects URL, checks visible text, salary scope, closest pager link and template JSON', async () => {
  await offline(async createPage => {
    const page = await createPage()
    await page.goto('https://hh.ru/search/vacancy')
    const report = await diagnoseSelectors(page, undefined, bundled())
    assert.equal(report.pageType, 'SEARCH')
    assert.equal(report.summary, 'PASSED')
    for (const key of ['currentPage','salaryValues','rubleCurrency','initialState'])
      assert.equal(report.rows.find(row => row.key === key)?.status, 'PASS', key)
  })
})

test('letter-open button is checked before opening the form; independent hints expose a broken form selector', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    let form = ''
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: vacancy
      + '<div class="vacancy-actions_responded"><button data-qa="responded-success-attach-cover-letter">Attach</button></div>' + form }))
    await page.goto('https://hh.ru/vacancy/123')
    const closed = await diagnoseSelectors(page, undefined, bundled())
    assert.equal(closed.rows.find(row => row.group === 'letterForm' && row.key === 'attach')?.status, 'PASS')
    assert.equal(closed.rows.find(row => row.group === 'letterForm' && row.key === 'form')?.status, 'STATE_NOT_CHECKED')
    form = '<div role="dialog"><form id="letter-form-test" action="/applicant/vacancy_response/edit_ajax"><input type="hidden" name="topicId" value="123"><textarea data-qa="vacancy-response-popup-form-letter-input"></textarea></form><button form="letter-form-test" data-qa="vacancy-response-letter-submit">Send</button></div>'
    await page.reload()
    const broken = await diagnoseSelectors(page, undefined, bundled(false, true))
    assert.equal(broken.rows.find(row => row.group === 'letterForm' && row.key === 'form')?.status, 'FAIL')
    assert.equal(broken.summary, 'FAILED')
    const valid = await diagnoseSelectors(page, undefined, bundled())
    assert.equal(valid.rows.find(row => row.group === 'letterForm' && row.key === 'form')?.status, 'PASS')
    assert.equal(valid.rows.find(row => row.group === 'letterForm' && row.key === 'submit')?.status, 'PASS')
    assert.equal(valid.rows.find(row => row.group === 'letterForm' && row.key === 'topic')?.status, 'PASS')
  } finally { await browser.close() }
})
