import assert from 'node:assert/strict'
import test from 'node:test'
import { isApplicationContextUrl, isExplicitLetterSuccess, isLetterPayload, isVacancyDetailUrl } from '../src/hh/application-evidence.js'

const target = 'https://hh.ru/vacancy/123'

test('detail identity ignores tracking but not vacancy, protocol or origin', () => {
  assert.equal(isVacancyDetailUrl(`${target}/?hhtmFrom=vacancy`, target), true)
  for (const url of ['https://hh.ru/vacancy/1234', 'https://hh.ru/search/vacancy',
    'https://other.example/vacancy/123', 'http://hh.ru/vacancy/123']) {
    assert.equal(isVacancyDetailUrl(url, target), false)
  }
})

test('response redirect must identify exactly the queued vacancy', () => {
  assert.equal(isApplicationContextUrl('https://hh.ru/applicant/vacancy_response?vacancyId=123', target, '123'), true)
  for (const query of ['vacancyId=1234', 'vacancyId=123&vacancyId=456', '']) {
    assert.equal(isApplicationContextUrl(`https://hh.ru/applicant/vacancy_response?${query}`, target, '123'), false)
  }
})

test('HTTP success and unfamiliar/contradictory JSON are not evidence of letter success', () => {
  assert.equal(isExplicitLetterSuccess({ success: true }), true)
  assert.equal(isExplicitLetterSuccess({ success: 'true' }), true)
  for (const payload of [null, '', {}, 'ok', [], { success: 'false' }, { success: false },
    { success: true, error: 'validation' }, { success: true, errors: ['required'] },
    { success: true, status: 'error' }]) assert.equal(isExplicitLetterSuccess(payload), false)
})

test('letter request matches the exact topic and text, including Unicode', async () => {
  const text = 'Здравствуйте!\nC++ & TypeScript'
  const encoded = new URLSearchParams({ topicId: '321', text }).toString()
  assert.equal(await isLetterPayload('application/x-www-form-urlencoded', encoded, '321', text), true)
  assert.equal(await isLetterPayload('application/x-www-form-urlencoded', encoded, '999', text), false)
  assert.equal(await isLetterPayload('application/x-www-form-urlencoded', encoded, '321', 'Other text'), false)
  assert.equal(await isLetterPayload('application/x-www-form-urlencoded', `${encoded}&topicId=999`, '321', text), false)
  assert.equal(await isLetterPayload('application/json', JSON.stringify({ topicId: 321, text }), '321', text), true)
  assert.equal(await isLetterPayload('application/json', '{', '321', text), false)
})

test('multipart letter request is supported without keeping token fields', async () => {
  const fields = new FormData()
  fields.set('topicId', '321')
  fields.set('text', 'Test\nletter')
  const encoded = new Response(fields)
  assert.equal(await isLetterPayload(encoded.headers.get('content-type')!, await encoded.text(), '321', 'Test\nletter'), true)
})
