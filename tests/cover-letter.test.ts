import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleLetter, prepareCoverLetter, type LetterTask } from '../src/generation/cover-letter.js'

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const task: LetterTask = { itemId: id, coverLetter: 'Обычное письмо.', resumePlainText: 'Разрабатывал Java API.',
  aiLetter: { enabled: true, template: 'Здравствуйте!\n\n#AI_CHANGE#\n\nСпасибо!', maxLength: 600 } }
const done = { id, status: 'done', result: { letter: 'Проектирую API на Java.' } }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

test('assembly preserves the literal template, checks full length and never expands model markers', () => {
  assert.equal(assembleLetter(task.aiLetter!, '$&'), 'Здравствуйте!\n\n$&\n\nСпасибо!')
  for (const text of ['', ' ', '#AI_CHANGE#', 'a'.repeat(600), '\0']) assert.throws(() => assembleLetter(task.aiLetter!, text))
  assert.throws(() => assembleLetter({ ...task.aiLetter!, template: '#AI_CHANGE##AI_CHANGE#' }, 'text'))
})
test('disabled AI and absent inputs never call the generation service', async () => {
  const fetcher: typeof fetch = async () => { throw new Error('Must not call') }
  assert.equal((await prepareCoverLetter({ ...task, aiLetter: { ...task.aiLetter!, enabled: false } }, 'vacancy', async () => true, { fetcher }))?.source, 'STATIC')
  assert.equal((await prepareCoverLetter(task, '', async () => true, { fetcher }))?.errorCode, 'VACANCY_TEXT_MISSING')
  assert.equal((await prepareCoverLetter({ ...task, resumePlainText: null }, 'vacancy', async () => true, { fetcher }))?.errorCode, 'RESUME_TEXT_MISSING')
})
test('one POST followed by polling, idempotency per task and body-only length budget', async () => {
  let posts = 0, polls = 0
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++
      const body = JSON.parse(String(init.body))
      assert.equal(body.maxLength, 600 - task.aiLetter!.template.length + '#AI_CHANGE#'.length)
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), `application-${id}`)
      return json({ id, status: 'queued' })
    }
    polls++; return json(done)
  }
  const result = await prepareCoverLetter(task, 'Vacancy', async () => true, { fetcher, pollMs: 0 })
  assert.equal(result?.source, 'GENERATED')
  assert.equal(result?.text, assembleLetter(task.aiLetter!, done.result.letter))
  assert.equal(posts, 1); assert.equal(polls, 1)
})
test('failures use exact nonempty fallback; empty fallback prohibits submission; no POST retry', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; throw new Error('private diagnostic') }
  const result = await prepareCoverLetter({ ...task, coverLetter: '' }, 'Vacancy', async () => true, { fetcher })
  assert.equal(result?.text, '')
  assert.equal(result?.source, 'AI_FAILED'); assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/)
  for (const response of [{ ...done, id: 'bad' }, { ...done, result: { letter: '#AI_CHANGE#' } }]) {
    const result = await prepareCoverLetter(task, 'Vacancy', async () => true, { fetcher: async () => json(response) })
    assert.equal(result?.source, 'FALLBACK'); assert.equal(result?.text, task.coverLetter)
  }
})

test('rate limit produces a pause signal, not fallback; confirmed fallback never calls generation', async () => {
  const reset = 1789829961
  const result = await prepareCoverLetter(task, 'Vacancy', async () => true, {
    fetcher: async () => json({ id, status: 'failed', error: { code: 'RATE_LIMIT', resetsAt: reset } }),
  })
  assert.deepEqual(result, { text: '', source: 'RATE_LIMIT', errorCode: 'RATE_LIMIT', generationId: id, resetsAt: reset })
  const confirmed = await prepareCoverLetter({ ...task, aiFallbackConfirmed: true }, 'Vacancy', async () => true, {
    fetcher: async () => { throw new Error('must not call generation') },
  })
  assert.equal(confirmed?.source, 'FALLBACK')
  assert.equal(confirmed?.text, task.coverLetter)
  assert.equal(confirmed?.errorCode, 'RATE_LIMIT_CONFIRMED')
})

test('explicit retry uses a new generation idempotency key', async () => {
  await prepareCoverLetter({ ...task, generationAttempt: 1 }, 'Vacancy', async () => true, { fetcher: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), `application-${task.itemId}-1`)
    return json(done)
  } })
})

test('empty and whitespace fallback turn every generation failure into attention, never an empty letter', async () => {
  for (const text of ['', ' ', '\n\t']) {
    for (const code of ['AUTH_REQUIRED', 'MODEL_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_OUTPUT', 'EMPTY_LETTER', 'CODEX_FAILED']) {
      const result = await prepareCoverLetter({ ...task, coverLetter: text }, 'Vacancy', async () => true,
        { fetcher: async () => json({ id, status: 'failed', error: { code } }) })
      assert.equal(result?.source, 'AI_FAILED')
      assert.equal(result?.text, '')
      assert.equal(result?.errorCode, code)
    }
  }
})

test('missing inputs and malformed template also prohibit fallback when it is empty', async () => {
  const cases: [LetterTask, string | null, string][] = [
    [{ ...task, coverLetter: '', resumePlainText: null }, 'Vacancy', 'RESUME_TEXT_MISSING'],
    [{ ...task, coverLetter: '' }, null, 'VACANCY_TEXT_MISSING'],
    [{ ...task, coverLetter: '', aiLetter: { ...task.aiLetter!, template: 'invalid' } }, 'Vacancy', 'INVALID_TEMPLATE'],
  ]
  for (const [input, vacancy, code] of cases) {
    const result = await prepareCoverLetter(input, vacancy, async () => true, { fetcher: async () => { throw new Error('must not generate') } })
    assert.equal(result?.source, 'AI_FAILED')
    assert.equal(result?.errorCode, code)
  }
  const staticLetter = await prepareCoverLetter({ ...task, coverLetter: '', aiLetter: { ...task.aiLetter!, enabled: false } }, null, async () => true)
  assert.equal(staticLetter?.source, 'STATIC')
})
test('pause after admission does not produce fallback or a letter for submission', async () => {
  let checks = 0
  const result = await prepareCoverLetter(task, 'Vacancy', async () => ++checks === 1, { fetcher: async () => json(done) })
  assert.equal(result, null)
})
test('failure to check run state is never treated as permission to proceed with fallback', async () => {
  await assert.rejects(prepareCoverLetter(task, 'Vacancy', async () => { throw new Error('Backend offline') }))
})
