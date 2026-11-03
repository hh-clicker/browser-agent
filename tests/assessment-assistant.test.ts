import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright'
import { installAssessmentAssistant, isAssessmentPage } from '../src/assessment/assistant.js'
import { ASSESSMENT_ASSISTANT_SCRIPT } from '../src/assessment/assistant-script.js'

const page = (url: string): Page => ({ url: () => url }) as Page

test('assistant is restricted to the expected HH assessment path', () => {
  assert.equal(isAssessmentPage(page('https://assessment.hh.ru/tests/123')), true)
  assert.equal(isAssessmentPage(page('https://assessment.hh.ru/tests/123?step=2')), true)
  for (const url of ['https://assessment.hh.ru/', 'https://evil.test/tests/123', 'http://assessment.hh.ru/tests/123', 'not a url']) {
    assert.equal(isAssessmentPage(page(url)), false)
  }
})

test('injected UI delegates through the binding and never calls localhost directly', () => {
  assert.doesNotThrow(() => new Function(ASSESSMENT_ASSISTANT_SCRIPT))
  assert.match(ASSESSMENT_ASSISTANT_SCRIPT, /__hhClickerAnswerAssessmentQuestion/)
  assert.doesNotMatch(ASSESSMENT_ASSISTANT_SCRIPT, /127\.0\.0\.1|localhost|\/questions/)
  assert.match(ASSESSMENT_ASSISTANT_SCRIPT, /input\[name="answer"\]/)
})

test('binding requires a user gesture and permits only one active call per page', async () => {
  let binding: ((source: { page: Page; frame: object }, input: unknown) => Promise<unknown>) | undefined
  const context = {
    exposeBinding: async (_name: string, callback: typeof binding) => { binding = callback },
    addInitScript: async () => undefined,
    pages: () => [],
  } as unknown as import('playwright').BrowserContext
  const frame = {}
  let activated = false
  const testPage = {
    url: () => 'https://assessment.hh.ru/tests/123', mainFrame: () => frame,
    evaluate: async () => activated,
  } as unknown as Page
  let finish: ((value: { answerNumber: number; answer: string; explanation: string; confidence: 'high' }) => void) | undefined
  const pending = new Promise<{ answerNumber: number; answer: string; explanation: string; confidence: 'high' }>(resolve => { finish = resolve })
  await installAssessmentAssistant(context, async () => pending)
  assert.ok(binding)
  await assert.rejects(binding!({ page: testPage, frame }, {}), { message: 'USER_GESTURE_REQUIRED' })
  activated = true
  const first = binding!({ page: testPage, frame }, {})
  await assert.rejects(binding!({ page: testPage, frame }, {}), { message: 'QUESTION_ALREADY_RUNNING' })
  finish!({ answerNumber: 1, answer: 'one', explanation: '', confidence: 'high' })
  assert.equal((await first as { answerNumber: number }).answerNumber, 1)
})
