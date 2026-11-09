import assert from 'node:assert/strict'
import test from 'node:test'
import { focusVacancyTab } from '../src/browser/vacancy-tab.js'

function tab(url: string, closed = false) {
  let focused = 0
  return { url: () => url, isClosed: () => closed, bringToFront: async () => { focused++ }, focused: () => focused }
}

test('explicit focus prefers the preserved application tab and does not navigate', async () => {
  const retained = tab('https://hh.ru/applicant/vacancy_response?vacancyId=123')
  const duplicate = tab('https://hh.ru/vacancy/123?tracking=x')
  const unrelated = tab('https://hh.ru/vacancy/456')
  await focusVacancyTab([retained, duplicate, unrelated], 'https://hh.ru/vacancy/123', retained)
  assert.equal(retained.focused(), 1)
  assert.equal(duplicate.focused(), 0)
  assert.equal(unrelated.focused(), 0)
})

test('closed, unrelated and assessment tabs never become fallback navigation', async () => {
  const pages = [tab('https://hh.ru/vacancy/123', true), tab('https://hh.ru/vacancy/456'),
    tab('https://assessment.hh.ru/vacancy/123'), tab('https://hh.ru/applicant/vacancy_response?vacancyId=456')]
  await assert.rejects(focusVacancyTab(pages, 'https://hh.ru/vacancy/123'), /Вкладка вакансии/)
  assert.ok(pages.every(page => page.focused() === 0))
  await assert.rejects(focusVacancyTab(pages, 'https://example.test/vacancy/123'), /Некорректная/)
})

test('an existing detail tab is focused when the retained tab is closed or has navigated away', async () => {
  const retained = tab('https://hh.ru/vacancy/456')
  const detail = tab('https://hh.ru/vacancy/123?tracking=x')
  await focusVacancyTab([retained, detail], 'https://hh.ru/vacancy/123', retained)
  assert.equal(detail.focused(), 1)
  assert.equal(retained.focused(), 0)
})

test('a retained application tab redirected to manual login or CAPTCHA can be focused', async () => {
  for (const url of ['https://hh.ru/account/login', 'https://hh.ru/captcha']) {
    const retained = tab(url)
    await focusVacancyTab([retained], 'https://hh.ru/vacancy/123', retained)
    assert.equal(retained.focused(), 1)
    await assert.rejects(focusVacancyTab([retained], 'https://hh.ru/vacancy/456'), /Вкладка вакансии/)
  }
})
