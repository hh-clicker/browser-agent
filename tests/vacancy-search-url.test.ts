import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSearchUrl } from '../src/hh/vacancy-search.js'

test('preserves an explicitly selected HH sort order', () => {
  const result = normalizeSearchUrl('https://hh.ru/search/vacancy?text=php&order_by=relevance&items_on_page=20&page=3')

  assert.equal(result.searchParams.get('order_by'), 'relevance')
  assert.equal(result.searchParams.get('items_on_page'), '100')
  assert.equal(result.searchParams.get('page'), '0')
})

test('does not add a sort order when HH should use its default', () => {
  const result = normalizeSearchUrl('https://hh.ru/search/vacancy?resume=resume-id')

  assert.equal(result.searchParams.has('order_by'), false)
  assert.equal(result.searchParams.get('items_on_page'), '100')
  assert.equal(result.searchParams.get('page'), '0')
})
