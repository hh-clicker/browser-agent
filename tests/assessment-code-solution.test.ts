import assert from 'node:assert/strict'
import test from 'node:test'
import { generateCodeSolution, type CodeSolutionInput } from '../src/assessment/code-solution.js'

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const input: CodeSolutionInput = {
  title: 'Сумма двух чисел', statement: 'Верните сумму a и b.', language: 'go',
  code: 'package main\n', taskNumber: 2, taskCount: 3,
}
const solution = { code: 'package main\n\nfunc sum(a, b int) int { return a + b }', explanation: 'Складываем числа.', warnings: [] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('code solution client sends one POST and accepts a validated result', async () => {
  let calls = 0
  const result = await generateCodeSolution(input, { fetcher: async (url, init) => {
    calls++
    assert.equal(new URL(String(url)).pathname, '/code-solutions')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), input)
    return json({ id, status: 'done', result: solution })
  } })
  assert.deepEqual(result, solution)
  assert.equal(calls, 1)
})

test('code solution client polls without a second POST', async () => {
  let posts = 0, polls = 0
  const result = await generateCodeSolution(input, { pollMs: 0, fetcher: async (_url, init) => {
    if (init?.method === 'POST') { posts++; return json({ id, status: 'queued' }) }
    polls++; return json({ id, status: 'done', result: solution })
  } })
  assert.deepEqual(result, solution)
  assert.equal(posts, 1)
  assert.equal(polls, 1)
})

test('code solution client rejects malformed page input and service output', async () => {
  let calls = 0
  await assert.rejects(generateCodeSolution({ ...input, statement: '' }, { fetcher: async () => { calls++; return json({}) } }),
    { message: 'INVALID_CODE_TASK' })
  assert.equal(calls, 0)
  for (const result of [{ ...solution, code: '' }, { ...solution, warnings: 'none' }, { ...solution, explanation: null }]) {
    await assert.rejects(generateCodeSolution(input, { fetcher: async () => json({ id, status: 'done', result }) }),
      { message: 'INVALID_RESPONSE' })
  }
})
