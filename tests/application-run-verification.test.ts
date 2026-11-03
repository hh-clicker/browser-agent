import assert from 'node:assert/strict'
import test from 'node:test'
import { isApplicationRunVerified, verifiedApplicationRun } from '../src/browser/application-run-verification.js'
import type { ApplicationTask } from '../src/hh/application.js'

const task: ApplicationTask = {
  itemId: 'item-1', runId: 'run-1', profileId: 'profile-1', hhResumeId: 'RESUME1', hhVacancyId: '123',
  sourceUrl: 'https://hh.ru/search/vacancy', searchPage: 0, coverLetter: '',
}

test('application identity is reused only inside the same run, profile and resume', () => {
  const verified = verifiedApplicationRun(task)

  assert.equal(isApplicationRunVerified(null, task), false)
  assert.equal(isApplicationRunVerified(verified, { ...task, itemId: 'item-2', hhVacancyId: '456' }), true)
  assert.equal(isApplicationRunVerified(verified, { ...task, runId: 'run-2' }), false)
  assert.equal(isApplicationRunVerified(verified, { ...task, profileId: 'profile-2' }), false)
  assert.equal(isApplicationRunVerified(verified, { ...task, hhResumeId: 'RESUME2' }), false)
})
