import assert from 'node:assert/strict'
import test from 'node:test'
import { searchScanTotalPages, searchTotalResultsFromInitialState } from '../src/hh/vacancy-search.js'

test('reads the approximate HH result count only from a valid initial state', () => {
  assert.equal(searchTotalResultsFromInitialState({ vacancySearchResult: { totalResults: 360 } }), 360)
  assert.equal(searchTotalResultsFromInitialState({ vacancySearchResult: { totalResults: -1 } }), null)
  assert.equal(searchTotalResultsFromInitialState({ vacancySearchResult: { totalResults: '360' } }), null)
  assert.equal(searchTotalResultsFromInitialState({}), null)
})

test('turns result count into pages without exceeding the configured limit', () => {
  assert.equal(searchScanTotalPages(360, 5, 1, true), 4)
  assert.equal(searchScanTotalPages(1200, 5, 1, true), 5)
  assert.equal(searchScanTotalPages(null, 5, 2, true), 5)
})

test('the observed last page is authoritative over an approximate result count', () => {
  assert.equal(searchScanTotalPages(360, 5, 3, false), 3)
  assert.equal(searchScanTotalPages(150, 5, 3, true), 3)
})
