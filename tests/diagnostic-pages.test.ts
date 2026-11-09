import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright'
import { DiagnosticPages } from '../src/browser/diagnostic-pages.js'

function page(url: string, closed = false): Page {
  return { url: () => url, isClosed: () => closed } as Page
}

test('explicit choice returns the exact page without navigation or focus inspection', () => {
  const choices = new DiagnosticPages()
  const pages = [page('https://hh.ru/applicant/profile/me'), page('https://hh.ru/vacancy/123?private=secret')]
  const list = choices.list(pages)
  assert.equal(list[1]!.label, '2. Вакансия №123')
  assert.equal(choices.selected(list[1]!.tabId, pages), pages[1])
  assert.ok(!JSON.stringify(list).includes('secret'))
  assert.ok(!JSON.stringify(list).includes('https:'))
})

test('closed, foreign, expired and cleared choices never fall back to another page', () => {
  const choices = new DiagnosticPages()
  let closed = false
  const selected = { url: () => 'https://hh.ru/search/vacancy', isClosed: () => closed } as Page
  const other = page('https://hh.ru/applicant/profile/me')
  const list = choices.list([selected, other])
  assert.throws(() => choices.selected(list[0]!.tabId, [other]), /список устарел/)
  closed = true
  assert.throws(() => choices.selected(list[0]!.tabId, [selected, other]), /список устарел/)
  const previous = list[1]!.tabId
  const refreshed = choices.list([other])
  assert.throws(() => choices.selected(previous, [other]), /список устарел/)
  choices.clear()
  assert.throws(() => choices.selected(refreshed[0]!.tabId, [other]), /список устарел/)
})

test('tab listing is bounded and excludes closed pages', () => {
  const choices = new DiagnosticPages()
  assert.equal(choices.list([page('about:blank', true)]).length, 0)
  const pages = Array.from({ length: 250 }, () => page('about:blank'))
  assert.equal(choices.list(pages).length, 200)
})
