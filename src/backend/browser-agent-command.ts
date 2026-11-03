import type { AuthorizationCheckResult } from '../hh/authorization-check.js'
import type { DiscoveredResume } from '../hh/resume-discovery.js'
import type { SearchVacancy } from '../hh/vacancy-search.js'
import type { ApplicationTask, ApplicationOutcome, ApplicationBlocker } from '../hh/application.js'

export type BrowserAgentCommandType = 'OPEN_BROWSER' | 'OPEN_URL' | 'CLOSE_BROWSER' | 'CHECK_AUTHORIZATION' | 'DISCOVER_RESUMES' | 'SCAN_SEARCH' | 'INSPECT_APPLICATION' | 'APPLY_VACANCY'
export type BrowserAgentCommandStatus = 'QUEUED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'

export interface BrowserAgentCommand {
  id: string
  type: BrowserAgentCommandType
  payload: OpenBrowserCommandPayload | null
  status: BrowserAgentCommandStatus
  agentId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
}

export interface OpenBrowserCommandPayload {
  profileId: string
  url: string | null
  searchId?: string | null
  pagesLimit?: number | null
  application?: ApplicationTask | null
  vacancyId?: string | null
}

export interface BrowserAgentCommandResult {
  commandId: string
  status: 'SUCCEEDED' | 'FAILED'
  errorMessage: string | null
  authorization: AuthorizationCheckResult | null
  resumes: DiscoveredResume[] | null
  vacancies: SearchVacancy[] | null
  application?: ApplicationOutcome | null
  applicationBlocker?: ApplicationBlocker | null
  vacancyPlainText?: string | null
}

export interface BrowserCommandExecutionResult {
  authorization?: AuthorizationCheckResult
  application?: ApplicationOutcome
  applicationBlocker?: ApplicationBlocker
  vacancyPlainText?: string
  resumes?: DiscoveredResume[] | null
  vacancies?: SearchVacancy[] | null
}
