import type { AuthorizationCheckResult } from '../hh/authorization-check.js'
import type { DiscoveredResume } from '../hh/resume-discovery.js'
import type { SearchVacancy } from '../hh/vacancy-search.js'
import type { ApplicationTask, ApplicationOutcome, ApplicationBlocker } from '../hh/application.js'
import type { DiagnosticPageType, DiagnosticMode, SelectorDiagnosticReport } from '../hh/selector-diagnostics.js'
import type { SelectorDiagnosticTarget } from '../hh/selector-diagnostic-runner.js'

export type BrowserAgentCommandType = 'OPEN_BROWSER' | 'OPEN_URL' | 'CLOSE_BROWSER' | 'CHECK_AUTHORIZATION' | 'DISCOVER_RESUMES' | 'SCAN_SEARCH' | 'INSPECT_APPLICATION' | 'APPLY_VACANCY' | 'DIAGNOSE_SELECTORS' | 'FOCUS_VACANCY' | 'FOCUS_DIAGNOSTIC'
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
  diagnosticPageType?: DiagnosticPageType | DiagnosticMode | null
  diagnosticTarget?: SelectorDiagnosticTarget | null
  profileId: string
  url: string | null
  searchId?: string | null
  pagesLimit?: number | null
  application?: ApplicationTask | null
  vacancyId?: string | null
}

export interface BrowserAgentCommandResult {
  selectorDiagnostics?: SelectorDiagnosticReport | null
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
  selectorDiagnostics?: SelectorDiagnosticReport
  authorization?: AuthorizationCheckResult
  application?: ApplicationOutcome
  applicationBlocker?: ApplicationBlocker
  vacancyPlainText?: string
  resumes?: DiscoveredResume[] | null
  vacancies?: SearchVacancy[] | null
}
