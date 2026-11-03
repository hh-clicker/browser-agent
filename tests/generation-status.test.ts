import assert from 'node:assert/strict'
import test from 'node:test'
import { checkGenerationStatus } from '../src/generation/status.js'

const requestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const health = { ok: true, cliVersion: '0.153.0', model: 'gpt-5.6-luna', reasoningEffort: 'low', queued: 2, running: 1 }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

test('explicit refresh posts to refresh endpoint; normal checks only read snapshots', async () => {
  const calls: string[] = []
  await checkGenerationStatus(requestId, new AbortController().signal, { refresh: true, fetcher: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push(`${init?.method} ${path}`)
    return json(path === '/health' ? health : { authenticated: true })
  } })
  assert.deepEqual(calls, ['GET /health', 'POST /auth/status/refresh'])
})

test('limit projection strips unknown fields and rejects malformed windows', async () => {
  const window = { usedPercent: 36, windowDurationMins: 300, resetsAt: 1789464317 }
  const result = await checkGenerationStatus(requestId, new AbortController().signal, { fetcher: async url =>
    json(new URL(String(url)).pathname === '/health' ? health : { authenticated: true,
      limits: { primary: { ...window, secret: 'private' }, secondary: { ...window, usedPercent: 101 } } }) })
  assert.deepEqual(result.limits, { primary: window, secondary: null })
  assert.doesNotMatch(JSON.stringify(result), /private/)
})

test('status uses only health and auth GETs, reports readiness and queue counters', async () => {
  const paths: string[] = []
  const result = await checkGenerationStatus(requestId, new AbortController().signal, { fetcher: async (url, init) => {
    assert.equal(init?.method, 'GET')
    assert.equal(init?.body, undefined)
    const path = new URL(String(url)).pathname
    paths.push(path)
    return json(path === '/health' ? health : { authenticated: true })
  } })
  assert.deepEqual(paths, ['/health', '/auth/status'])
  assert.equal(result.state, 'READY')
  assert.equal(result.model, 'gpt-5.6-luna')
  assert.equal(result.queued, 2)
  assert.equal(result.requestId, requestId)
})
test('only explicit missing auth becomes AUTH_REQUIRED; unknown auth stays unconfirmed', async () => {
  for (const [auth, expected] of [
    [{ authenticated: false, error: { code: 'AUTH_REQUIRED' } }, 'AUTH_REQUIRED'],
    [{ authenticated: false, error: { code: 'AUTH_CHECK_FAILED' } }, 'CHECK_FAILED'],
    [{ authenticated: 'true' }, 'CHECK_FAILED'],
  ] as const) {
    const result = await checkGenerationStatus(requestId, new AbortController().signal, { fetcher: async url =>
      json(new URL(String(url)).pathname === '/health' ? health : auth) })
    assert.equal(result.state, expected)
  }
})
test('failed health and missing CLI do not show ready or probe authorization', async () => {
  for (const response of [json({}, 503), json({ ...health, cliVersion: null })]) {
    let calls = 0
    const result = await checkGenerationStatus(requestId, new AbortController().signal, { fetcher: async () => { calls++; return response } })
    assert.equal(calls, 1)
    assert.notEqual(result.state, 'READY')
  }
})
test('raw diagnostics are not returned to the frontend', async () => {
  const result = await checkGenerationStatus(requestId, new AbortController().signal, { fetcher: async () => { throw new Error('private credential') } })
  assert.equal(result.state, 'UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(result), /private credential/)
})
