import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'
import { diagnoseSelectors } from '../src/hh/selector-diagnostics.js'

function groups() {
  return ['vacancy', 'response-form', 'letter-form'].map(name => parseSelectorGroup(JSON.parse(
    readFileSync(new URL(`../resources/hh-selectors/${name}.json`, import.meta.url), 'utf8'))))
}
const detail = '<h1 data-qa="vacancy-title">Role</h1><div data-qa="vacancy-description">Tasks</div>'
const delivered = '<section class="vacancy-actions_magritte-vacancy-top"></section><section class="vacancy-actions_responded">Резюме доставлено<button data-qa="vacancy-response-link-view-topic">Открыть отклик</button></section>'
async function offline(html: string, run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
    await page.goto('https://hh.ru/vacancy/123')
    await run(page)
  } finally { await browser.close() }
}

test('letter form validates dynamic id and actual external submit association without leaking values', async () => {
  const registry = new SelectorRegistry(groups())
  for (const mode of ['valid', 'wrong-form', 'missing-id', 'disabled']) {
    const id = mode === 'missing-id' ? '' : 'dynamic-form'
    await offline(`${detail}${delivered}<div role="dialog">
      <form id="${id}" action="/applicant/vacancy_response/edit_ajax">
        <input type="hidden" name="topicId" value="PRIVATE_TOPIC">
        <textarea data-qa="vacancy-response-popup-form-letter-input">PRIVATE_LETTER</textarea>
      </form><button data-qa="vacancy-response-letter-submit" form="${mode === 'wrong-form' ? 'other' : id}" ${mode === 'disabled' ? 'disabled' : ''}>Send</button></div>`, async page => {
      const report = await diagnoseSelectors(page, 'VACANCY', registry)
      const rows = report.rows.filter(row => row.group === 'letterForm')
      assert.equal(rows.find(row => row.key === 'form')?.status, mode === 'missing-id' ? 'FAIL' : 'PASS')
      assert.equal(rows.find(row => row.key === 'submit')?.status,
        mode === 'wrong-form' || mode === 'missing-id' ? 'FAIL' : mode === 'disabled' ? 'STATE_NOT_CHECKED' : 'PASS')
      assert.equal(rows.find(row => row.key === 'topic')?.status, 'PASS')
      assert.equal(rows.find(row => row.key === 'letter')?.status, 'PASS')
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TOPIC|PRIVATE_LETTER/)
      assert.equal(await page.locator('textarea').inputValue(), 'PRIVATE_LETTER')
    })
  }
})

function responseForm(selectable: boolean, list = '') {
  return `${detail}<section class="vacancy-actions_magritte-vacancy-top"><a data-qa="vacancy-response-link-top" href="/applicant/vacancy_response?vacancyId=123">Respond</a></section>
    <div role="dialog"><form id="RESPONSE_MODAL_FORM_ID" name="vacancy_response">
      <div class="${selectable ? 'magritte-select-layout' : 'fixed-resume'}"><div role="button" aria-expanded="${Boolean(list)}"><span data-qa="resume-title">Role</span></div></div>
      <textarea data-qa="vacancy-response-popup-form-letter-input"></textarea>
    </form><button data-qa="vacancy-response-submit-popup" form="RESPONSE_MODAL_FORM_ID">Send</button>${list}</div>`
}

test('fixed resume is not applicable, closed selectable list is an unobserved state', async () => {
  for (const selectable of [false, true]) await offline(responseForm(selectable), async page => {
    const report = await diagnoseSelectors(page, 'VACANCY', new SelectorRegistry(groups()))
    for (const key of ['resumeList','resumeOptions','selectedResume'])
      assert.equal(report.rows.find(row => row.group === 'responseForm' && row.key === key)?.status,
        selectable ? 'STATE_NOT_CHECKED' : 'NOT_APPLICABLE')
    assert.equal(report.rows.find(row => row.group === 'responseForm' && row.key === 'submit')?.status, 'PASS')
    assert.equal(report.summary, 'PASSED')
  })
})

test('open resume options validate identity and ARIA attributes rather than reporting unsupported rules', async () => {
  const hash = 'a'.repeat(36)
  for (const malformed of [false, true]) {
    const list = `<div data-qa="magritte-select-option-list" role="listbox">
      <div role="option" data-magritte-select-option="${hash}" aria-selected="true" aria-disabled="${malformed ? 'yes' : 'false'}">Role</div>
    </div>`
    await offline(responseForm(true, list), async page => {
      const report = await diagnoseSelectors(page, 'VACANCY', new SelectorRegistry(groups()))
      assert.equal(report.rows.find(row => row.key === 'resumeOptions')?.status, malformed ? 'FAIL' : 'PASS')
      assert.equal(report.rows.find(row => row.key === 'selectedResume')?.status, 'PASS')
      assert.doesNotMatch(JSON.stringify(report), new RegExp(hash))
    })
  }
})

test('archive checks distinguish unobserved state from missing markers on a confirmed archive', async () => {
  await offline(detail, async page => {
    const report = await diagnoseSelectors(page, 'VACANCY', new SelectorRegistry(groups()))
    assert.ok(report.rows.filter(row => row.key.startsWith('archived')).every(row => row.status === 'STATE_NOT_CHECKED'))
  })
  const source = groups()
  const vacancy = source.find(group => group.id === 'vacancy')!
  vacancy.selectors.archivedTitle!.value = '.missing-archive-title'
  vacancy.selectors.archivedDescription!.value = '.missing-archive-description'
  await offline('<h1 data-qa="vacancy-title">Role <span data-qa="vacancy-title-archived-text">В архиве</span></h1>', async page => {
    const report = await diagnoseSelectors(page, 'VACANCY', new SelectorRegistry(source))
    assert.equal(report.summary, 'FAILED')
    assert.ok(report.rows.filter(row => row.key.startsWith('archived')).every(row => row.status === 'FAIL'))
  })
  const partial = groups()
  partial.find(group => group.id === 'vacancy')!.selectors.archivedDescription!.value = '.missing-description'
  await offline('<h1 data-qa="vacancy-title">Role <span data-qa="vacancy-title-archived-text">В архиве</span></h1><p data-qa="vacancy-archive-description">Закрыта</p>', async page => {
    const report = await diagnoseSelectors(page, 'VACANCY', new SelectorRegistry(partial))
    assert.equal(report.rows.find(row => row.key === 'archivedTitle')?.status, 'PASS')
    assert.equal(report.rows.find(row => row.key === 'archivedDescription')?.status, 'FAIL')
  })
})

test('expanded resume trigger with a broken list selector is not misreported as a closed list', async () => {
  const source = groups()
  source.find(group => group.id === 'responseForm')!.selectors.resumeList!.value = '.missing-list'
  await offline(responseForm(true, '<div data-qa="magritte-select-option-list" role="listbox"><div role="option">Role</div></div>'), async page => {
    const report = await diagnoseSelectors(page, 'VACANCY', new SelectorRegistry(source))
    assert.equal(report.rows.find(row => row.key === 'resumeList')?.status, 'FAIL')
    assert.equal(report.rows.find(row => row.key === 'resumeOptions')?.status, 'NOT_CHECKED')
  })
})
