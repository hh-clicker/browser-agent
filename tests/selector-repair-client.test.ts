import test from 'node:test'
import assert from 'node:assert/strict'
import { generateSelectorRepair, type SelectorRepairInput } from '../src/generation/selector-repair.js'

const id = '11111111-1111-4111-8111-111111111111'
const input = { group: { schemaVersion: 1, id: 'profile', selectors: {} }, brokenKeys: ['root'], diagnostics: [], html: '<main></main>' } as SelectorRepairInput

test('repair creates one job then only polls its ID', async () => {
  const methods: string[] = []
  const result = await generateSelectorRepair(input, 'command', { pollMs: 1, fetcher: async (_url, init) => {
    if (init?.method === 'POST') assert.deepEqual(JSON.parse(String(init.body)).diagnostics, input.diagnostics)
    methods.push(init?.method ?? 'GET')
    return Response.json(methods.length === 1 ? { id, status: 'queued' }
      : { id, status: 'done', result: { selectors: { root: { kind: 'css', value: 'main' } } } })
  } })
  assert.deepEqual(methods, ['POST', 'GET'])
  assert.deepEqual(result, { selectors: { root: { kind: 'css', value: 'main' } } })
})

test('lost POST response is never retried', async () => {
  let calls = 0
  await assert.rejects(generateSelectorRepair(input, 'command', { fetcher: async () => { calls++; throw new Error('private network error') } }), /Автоматического повтора/)
  assert.equal(calls, 1)
})

test('review is a separate idempotent job and retains the candidate explanations in its body', async () => {
  const review = { candidate: { selectors: {}, audit: {} }, observations: { fields: [] } }
  await generateSelectorRepair({ ...input, review }, 'command-review', { fetcher: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'selector-repair-command-review')
    assert.deepEqual(JSON.parse(String(init?.body)).review, review)
    return Response.json({ id, status: 'done', result: { selectors: {}, audit: {} } })
  } })
})

test('auth and rate limits remain distinguishable without exposing service output', async () => {
  for (const [code, expected] of [['AUTH_REQUIRED', /Войдите в Codex/], ['RATE_LIMIT', /Лимит Codex/], ['INPUT_TOO_LARGE', /отдельного файла/]] as const) {
    await assert.rejects(generateSelectorRepair(input, 'command', {
      fetcher: async () => Response.json({ id, status: 'failed', error: { code, message: 'PRIVATE' } }),
    }), expected)
  }
})
