import assert from 'node:assert/strict'
import test from 'node:test'
import { answerAssessmentQuestion, type AssessmentQuestionInput } from '../src/assessment/question.js'

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const input: AssessmentQuestionInput = {
  question: 'Сколько будет 2 + 2?', answers: ['3', '4', '5'], title: 'Арифметика', taskNumber: 1, taskCount: 5,
}
const answer = { answerNumber: 2, answer: '4', explanation: 'Сумма равна четырём.', confidence: 'high' as const }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('question client sends one POST and accepts a validated answer', async () => {
  let calls = 0
  const result = await answerAssessmentQuestion(input, { fetcher: async (url, init) => {
    calls++
    assert.equal(new URL(String(url)).pathname, '/questions')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init.headers).has('Idempotency-Key'), false)
    assert.deepEqual(JSON.parse(String(init?.body)), input)
    return json({ id, status: 'done', result: answer })
  } })
  assert.deepEqual(result, answer)
  assert.equal(calls, 1)
})

test('question client polls without resubmitting and preserves a safe service error code', async () => {
  let posts = 0, polls = 0
  const result = await answerAssessmentQuestion(input, { pollMs: 0, fetcher: async (_url, init) => {
    if (init?.method === 'POST') { posts++; return json({ id, status: 'queued' }) }
    polls++; return json({ id, status: 'done', result: answer })
  } })
  assert.deepEqual(result, answer)
  assert.equal(posts, 1)
  assert.equal(polls, 1)
  await assert.rejects(answerAssessmentQuestion(input, { fetcher: async () => json({ id, status: 'failed', error: { code: 'RATE_LIMIT' } }) }),
    { message: 'RATE_LIMIT' })
})

test('question client rejects malformed page input and forged service output', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return json({}) }
  await assert.rejects(answerAssessmentQuestion({ ...input, answers: ['one'] }, { fetcher }), { message: 'INVALID_QUESTION' })
  assert.equal(calls, 0)
  for (const result of [
    { ...answer, answerNumber: 4 }, { ...answer, answer: 'подменённый вариант' }, { ...answer, confidence: 'certain' },
  ]) {
    await assert.rejects(answerAssessmentQuestion(input, { fetcher: async () => json({ id, status: 'done', result }) }),
      { message: 'INVALID_RESPONSE' })
  }
})
