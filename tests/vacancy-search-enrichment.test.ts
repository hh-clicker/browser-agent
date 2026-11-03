import assert from 'node:assert/strict'
import test from 'node:test'
import { vacancyEnrichmentFromInitialState } from '../src/hh/vacancy-search-enrichment.js'

const state = {
  professionalRoleTree: { items: [{ items: [{ id: '96', text: 'Программист, разработчик' }] }] },
  vacancySearchResult: { vacancies: [{
    vacancyId: 123,
    publicationTime: { $: '2026-09-11T19:23:48+03:00' },
    lastChangeTime: { $: '2026-09-11T21:37:32+03:00' },
    creationTime: '2026-08-15T20:43:35+03:00',
    workFormats: [{ workFormatsElement: ['REMOTE', 'ON_SITE'] }],
    workScheduleByDays: [{ workScheduleByDaysElement: ['FIVE_ON_TWO_OFF'] }],
    workingHours: [{ workingHoursElement: ['HOURS_8'] }],
    professionalRoleIds: [{ professionalRoleId: [96] }],
    languages: [{ language: [{ isoCode: 'eng', degree: 'b1' }] }],
    compensation: { from: 160000, to: 220000, currencyCode: 'RUR', gross: true, mode: 'MONTH', frequency: 'TWICE_PER_MONTH' },
    company: { '@trusted': true, accreditedITEmployer: true, employerReviews: { totalRating: '4.3', reviewsCount: 127 } },
    address: { displayName: 'Москва, Бауманская улица', metroStations: { metro: [{ name: 'Бауманская' }] } },
  }] },
}

test('uses matching initial state as structured vacancy enrichment', () => {
  const result = vacancyEnrichmentFromInitialState(['123'], state)
  assert.equal(result?.[0]?.publishedAt, '2026-09-11T19:23:48+03:00')
  assert.deepEqual(result?.[0]?.enrichment.workFormats, ['REMOTE', 'ON_SITE'])
  assert.deepEqual(result?.[0]?.enrichment.professionalRoles, ['Программист, разработчик'])
  assert.deepEqual(result?.[0]?.enrichment.workScheduleByDays, ['FIVE_ON_TWO_OFF'])
  assert.deepEqual(result?.[0]?.enrichment.workingHours, ['HOURS_8'])
  assert.deepEqual(result?.[0]?.enrichment.languages, [{ code: 'eng', level: 'b1' }])
  assert.deepEqual(result?.[0]?.enrichment.compensation, {
    from: 160000, to: 220000, currency: 'RUR', gross: true, mode: 'MONTH', frequency: 'TWICE_PER_MONTH',
  })
  assert.equal(result?.[0]?.enrichment.employerReviewsCount, 127)
  assert.deepEqual(result?.[0]?.enrichment.metroStations, ['Бауманская'])
})

test('rejects stale initial state when ids or order differ from rendered cards', () => {
  assert.equal(vacancyEnrichmentFromInitialState(['999'], state), null)
  assert.equal(vacancyEnrichmentFromInitialState(['123', '456'], state), null)
})

test('missing or malformed initial state is an optional enrichment miss', () => {
  assert.equal(vacancyEnrichmentFromInitialState(['123'], null), null)
  assert.equal(vacancyEnrichmentFromInitialState(['123'], { vacancySearchResult: { vacancies: [null] } }), null)
})
