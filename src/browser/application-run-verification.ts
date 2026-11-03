import type { ApplicationTask } from '../hh/application.js'

export interface VerifiedApplicationRun {
  runId: string
  profileId: string
  hhResumeId: string
}

export function verifiedApplicationRun(task: ApplicationTask): VerifiedApplicationRun {
  return { runId: task.runId, profileId: task.profileId, hhResumeId: task.hhResumeId }
}

export function isApplicationRunVerified(verified: VerifiedApplicationRun | null, task: ApplicationTask): boolean {
  return verified !== null
    && verified.runId === task.runId
    && verified.profileId === task.profileId
    && verified.hhResumeId === task.hhResumeId
}
