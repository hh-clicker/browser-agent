import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright'
import { installCodeAssistant, isCodeAssessmentPage } from '../src/assessment/code-assistant.js'
import { CODE_ASSISTANT_SCRIPT } from '../src/assessment/code-assistant-script.js'

const page = (url: string): Page => ({ url: () => url }) as Page

test('code assistant is restricted to the expected HH practical-task path', () => {
  assert.equal(isCodeAssessmentPage(page('https://assessment.hh.ru/code/322406')), true)
  assert.equal(isCodeAssessmentPage(page('https://assessment.hh.ru/code/322406?step=2')), true)
  for (const url of ['https://assessment.hh.ru/tests/322406', 'https://evil.test/code/322406',
    'http://assessment.hh.ru/code/322406', 'https://assessment.hh.ru/code/not-a-number']) {
    assert.equal(isCodeAssessmentPage(page(url)), false)
  }
})

test('injected code UI stays read-only, uses the left side and cannot run or submit a task', () => {
  assert.doesNotThrow(() => new Function(CODE_ASSISTANT_SCRIPT))
  assert.match(CODE_ASSISTANT_SCRIPT, /__hhClickerGenerateCodeSolution/)
  assert.match(CODE_ASSISTANT_SCRIPT, /left:20px/)
  assert.match(CODE_ASSISTANT_SCRIPT, /monaco\?\.editor\?\.tokenize/)
  assert.doesNotMatch(CODE_ASSISTANT_SCRIPT, /pushEditOperations|Вставить в редактор|clipboard|>Copy</)
  assert.doesNotMatch(CODE_ASSISTANT_SCRIPT, /127\.0\.0\.1|localhost|\/code-solutions/)
  assert.doesNotMatch(CODE_ASSISTANT_SCRIPT, /execute-code-button|submit-solution-button/)
})

test('code binding requires a user gesture and permits only one active call per page', async () => {
  let binding: ((source: { page: Page; frame: object }, input: unknown) => Promise<unknown>) | undefined
  const context = {
    exposeBinding: async (_name: string, callback: typeof binding) => { binding = callback },
    addInitScript: async () => undefined,
    pages: () => [],
  } as unknown as import('playwright').BrowserContext
  const frame = {}
  let activated = false
  const testPage = {
    url: () => 'https://assessment.hh.ru/code/322406', mainFrame: () => frame,
    evaluate: async () => activated,
  } as unknown as Page
  let finish: ((value: { code: string; explanation: string; warnings: string[] }) => void) | undefined
  const pending = new Promise<{ code: string; explanation: string; warnings: string[] }>(resolve => { finish = resolve })
  await installCodeAssistant(context, async () => pending)
  assert.ok(binding)
  await assert.rejects(binding!({ page: testPage, frame }, {}), { message: 'USER_GESTURE_REQUIRED' })
  activated = true
  const first = binding!({ page: testPage, frame }, {})
  await assert.rejects(binding!({ page: testPage, frame }, {}), { message: 'CODE_SOLUTION_ALREADY_RUNNING' })
  finish!({ code: 'package main', explanation: '', warnings: [] })
  assert.equal((await first as { code: string }).code, 'package main')
})
