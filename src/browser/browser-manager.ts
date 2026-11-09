import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { installAssessmentAssistant } from '../assessment/assistant.js'
import { installCodeAssistant } from '../assessment/code-assistant.js'
import { checkAuthorization, HH_PROFILE_URL, type AuthorizationCheckResult } from '../hh/authorization-check.js'
import { readResumeCards, type DiscoveredResume } from '../hh/resume-discovery.js'
import { readResumePrintText } from '../hh/resume-text.js'
import { collectSearch, normalizeSearchUrl, type SearchScanProgressReporter, type SearchVacancy } from '../hh/vacancy-search.js'
import { describeSearchScanFailure, SearchScanError } from '../hh/search-scan-error.js'
import { applyVacancy, applicationBarrier, inspectApplication, vacancyArchived, type ApplicationTask, type ApplicationControl, type ApplicationOutcome, type ApplicationBlocker } from '../hh/application.js'
import { extractVacancyText } from '../hh/vacancy-text.js'
import { diagnoseSelectors, type DiagnosticPageType, type SelectorDiagnosticReport } from '../hh/selector-diagnostics.js'
import { isVacancyDetailUrl } from '../hh/application-evidence.js'
import { isApplicationRunVerified, verifiedApplicationRun, type VerifiedApplicationRun } from './application-run-verification.js'
import { DiagnosticPages } from './diagnostic-pages.js'
import { focusVacancyTab } from './vacancy-tab.js'
import { runFullSelectorDiagnostics, type SelectorDiagnosticTarget } from '../hh/selector-diagnostic-runner.js'
import { loadHhSelectors } from '../hh/selector-registry.js'
import { offerSelectorRepair, repairReadSelectors } from '../hh/selector-repair.js'
import { runtimeSelectorIssue } from '../hh/runtime-selector-issue.js'

import type { OpenBrowserCommandPayload } from '../backend/browser-agent-command.js'
import type { BrowserConfig } from '../config/browser-config.js'

export class BrowserManager {
  readonly #config: BrowserConfig
  #context: BrowserContext | null = null
  #activeProfileId: string | null = null
  #opening: Promise<void> | null = null
  #authorizationPage: Page | null = null
  #verifiedApplicationRun: VerifiedApplicationRun | null = null
  readonly #applicationPages = new Map<string, Page>()
  readonly #diagnosticPages = new Map<string, Page>()
  readonly #diagnosticChoices = new DiagnosticPages()
  #fullDiagnostic: { report: SelectorDiagnosticReport; target: SelectorDiagnosticTarget } | null = null
  #runtimePage: Page | null = null
  #runtimeWarning: SelectorDiagnosticReport | null = null

  beginRuntimeCommand(): void { this.#runtimePage = null; this.#runtimeWarning = null }

  #retainDiagnosticPage(page: Page): string {
    for (const [id, previous] of this.#diagnosticPages) {
      if (previous.isClosed()) this.#diagnosticPages.delete(id)
      else if (previous === page) return id
    }
    if (this.#diagnosticPages.size >= 40) this.#diagnosticPages.delete(this.#diagnosticPages.keys().next().value!)
    const id = randomUUID(); this.#diagnosticPages.set(id, page); return id
  }

  async finishRuntimeCommand(problem: boolean): Promise<SelectorDiagnosticReport | null> {
    const page = this.#runtimePage
    const report = (problem && page ? await runtimeSelectorIssue(page) : null) ?? this.#runtimeWarning
    if (!report) return null
    if (!report.tabId && page && !page.isClosed()) report.tabId = this.#retainDiagnosticPage(page)
    // Repair availability is re-evaluated only after an explicit diagnostic action.
    report.repairableGroups = []
    return report
  }

  constructor(config: BrowserConfig) {
    this.#config = config
  }

  get isOpen(): boolean {
    return this.#context !== null
  }

  get activeProfileId(): string | null {
    return this.#activeProfileId
  }

  async diagnoseSelectors(profileId: string, pageType: DiagnosticPageType | 'CURRENT' | 'FULL', target?: SelectorDiagnosticTarget | null, requestId: string = randomUUID()): Promise<SelectorDiagnosticReport> {
    if (!this.#context || this.#activeProfileId !== profileId) throw new Error('Профиль браузера не запущен')
    const context = this.#context
    const ports = {
      createPage: () => this.#newBackgroundPage(context),
      retainPage: (page: Page) => {
        for (const [id, previous] of this.#diagnosticPages) if (previous.isClosed()) this.#diagnosticPages.delete(id)
        if (this.#diagnosticPages.size >= 40) this.#diagnosticPages.delete(this.#diagnosticPages.keys().next().value!)
        const id = randomUUID(); this.#diagnosticPages.set(id, page); return id
      },
    }
    if (target?.repairGroup) {
      if (pageType !== 'CURRENT' || !target.tabId) throw new Error('Для исправления выберите проверенную вкладку.')
      const page = this.#diagnosticPages.get(target.tabId) ?? this.#diagnosticChoices.get(target.tabId)
      if (!page || page.isClosed() || !context.pages().includes(page)) throw new Error('Вкладка закрыта или список устарел. Повторите диагностику.')
      const result = await repairReadSelectors(page, target.repairGroup, requestId)
      result.tabId = target.tabId
      const full = this.#fullDiagnostic
      if (full?.report.scenarios?.some(step => step.tabId === target.tabId && step.pageType === result.pageType)) {
        full.report = await runFullSelectorDiagnostics(full.target, ports, loadHhSelectors(), { previous: full.report, repaired: result, page })
        return full.report
      }
      return result
    }
    if (pageType === 'FULL') {
      this.#fullDiagnostic = null
      const diagnosticTarget = target ?? { hhResumeId: null, searchUrl: null, searchName: null }
      const result = await runFullSelectorDiagnostics(diagnosticTarget, ports)
      this.#fullDiagnostic = { report: structuredClone(result), target: structuredClone(diagnosticTarget) }
      return result
    }
    if (pageType !== 'CURRENT') {
      const pages = context.pages().filter(page => !page.isClosed())
      if (pages.length !== 1) throw new Error('Для проверки выберите вкладку через режим CURRENT.')
      return diagnoseSelectors(pages[0]!, pageType)
    }
    if (!target?.tabId) {
      return { pageType: 'UNKNOWN', checkedAt: new Date().toISOString(), status: 'SELECT_TAB',
        message: 'Выберите открытую вкладку для проверки.', rows: [],
        tabs: this.#diagnosticChoices.list(context.pages()) }
    }
    const retained = this.#diagnosticPages.get(target.tabId)
    const page = retained && !retained.isClosed() && context.pages().includes(retained)
      ? retained : this.#diagnosticChoices.selected(target.tabId, context.pages())
    const registry = loadHhSelectors()
    const result = await offerSelectorRepair(page, await diagnoseSelectors(page, undefined, registry), registry)
    result.tabId = target.tabId
    return result
  }

  async focusDiagnostic(profileId: string, tabId: string): Promise<void> {
    const page = this.#diagnosticPages.get(tabId) ?? this.#diagnosticChoices.get(tabId)
    if (!this.#context || this.#activeProfileId !== profileId || !page || page.isClosed() || !this.#context.pages().includes(page))
      throw new Error('Вкладка диагностики уже закрыта или браузер перезапущен.')
    await page.bringToFront().catch(() => { throw new Error('Не удалось показать вкладку диагностики.') })
  }

  async #newBackgroundPage(context: BrowserContext): Promise<Page> {
    const anchor = context.pages().find(page => !page.isClosed())
    if (!anchor) throw new Error('Не удалось открыть фоновую вкладку: нет открытых вкладок браузера.')

    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null
    try {
      session = await context.newCDPSession(anchor)
      const nextPage = context.waitForEvent('page', { timeout: 10_000 })
      void nextPage.catch(() => undefined)
      const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true })
      try {
        return await nextPage
      } catch {
        await session.send('Target.closeTarget', { targetId }).catch(() => undefined)
      }
    } catch {
      // Keep the browser usable if the installed Chrome does not support background targets.
    } finally {
      await session?.detach().catch(() => undefined)
    }
    throw new Error('Не удалось открыть фоновую вкладку браузера.')
  }

  async open(payload: OpenBrowserCommandPayload): Promise<void> {
    if (this.#context) {
      if (this.#activeProfileId === payload.profileId && this.#context.pages().some(page => !page.isClosed())) {
        return
      }
      await this.close()
    }

    if (this.#opening) {
      return this.#opening
    }

    this.#opening = this.#launch(payload)

    try {
      await this.#opening
    } finally {
      this.#opening = null
    }
  }

  async close(): Promise<void> {
    if (this.#opening) {
      await this.#opening
    }

    const context = this.#context

    if (!context) {
      return
    }

    this.#context = null
    this.#activeProfileId = null
    this.#authorizationPage = null
    this.#verifiedApplicationRun = null
    this.#applicationPages.clear()
    this.#diagnosticPages.clear()
    this.#diagnosticChoices.clear()
    this.#fullDiagnostic = null
    await context.close()
  }

  async focusVacancy(profileId: string, url: string): Promise<void> {
    if (!this.#context || this.#activeProfileId !== profileId) throw new Error('Браузер нужного аккаунта закрыт.')
    const id = new URL(url).pathname.split('/')[2] ?? ''
    await focusVacancyTab(this.#context.pages(), url, this.#applicationPages.get(id))
  }

  async checkAuthorization(profileId: string): Promise<AuthorizationCheckResult> {
    const context = this.#context
    if (!context || this.#activeProfileId !== profileId) throw new Error('Профиль браузера не запущен')

    if (!this.#authorizationPage || this.#authorizationPage.isClosed() || !this.#isAuthorizationPage(this.#authorizationPage)) {
      // Повторно используем только страницу профиля или пустую вкладку, не чужую открытую вакансию.
      this.#authorizationPage = context.pages().find((page) => page.url().split('?')[0] === HH_PROFILE_URL)
        ?? context.pages().find((page) => page.url() === 'about:blank')
        ?? await this.#newBackgroundPage(context)
    }
    const page = this.#authorizationPage
    this.#runtimePage = page
    const authorization = await checkAuthorization(page)
    return authorization
  }

  #isAuthorizationPage(page: Page): boolean {
    if (page.url() === 'about:blank') return true
    try {
      const url = new URL(page.url())
      return url.protocol === 'https:' && (url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
        && /^\/(?:applicant\/profile\/me|account\/login|auth\/applicant|captcha)(?:\/|$)/.test(url.pathname)
    } catch {
      return false
    }
  }

  async discoverResumes(profileId: string, resumeUrl?: string | null): Promise<{ authorization: AuthorizationCheckResult; resumes: DiscoveredResume[] | null }> {
    const authorization = await this.checkAuthorization(profileId)
    if (authorization.status !== 'AUTHORIZED') return { authorization, resumes: null }
    const page = this.#authorizationPage
    if (!page || page.isClosed()) throw new Error('Вкладка профиля закрыта. Повторите поиск резюме.')
    const resumes = await readResumeCards(page)
    if (!resumeUrl) return { authorization, resumes }
    const url = new URL(resumeUrl)
    const hash = url.pathname.match(/^\/resume\/([a-f0-9]{20,100})$/)?.[1]
    const selected = resumes.find(resume => resume.hhResumeId === hash)
    if (url.origin !== 'https://hh.ru' || url.search !== '?print=true' || !selected || !this.#context) {
      throw new Error('Резюме не найдено в текущем аккаунте HH. Повторите поиск резюме.')
    }
    const context = this.#context
    const plainText = await readResumePrintText(async () => {
      const printPage = await this.#newBackgroundPage(context)
      this.#runtimePage = printPage
      return printPage
    }, selected.hhResumeId, loadHhSelectors(), async printPage => {
      const issue = await runtimeSelectorIssue(printPage)
      if (issue) { issue.tabId = this.#retainDiagnosticPage(printPage); this.#runtimeWarning = issue; return true }
      return false
    })
    return { authorization, resumes: [{ ...selected, plainText }] }
  }

  async openUrl(profileId: string, url: string): Promise<void> {
    if (!this.#context || this.#activeProfileId !== profileId) {
      throw new Error('Профиль браузера не запущен')
    }

    const page = await this.#newBackgroundPage(this.#context)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    } catch (error: unknown) {
      await page.close().catch(() => undefined)
      throw error
    }
  }

  async inspectApplication(profileId: string, url: string): Promise<ApplicationOutcome> {
    const context = this.#context
    if (!context || this.#activeProfileId !== profileId) return 'BROWSER_UNAVAILABLE'
    const page = await this.#newBackgroundPage(context)
    this.#runtimePage = page
    const outcome = await inspectApplication(page, url)
    if (outcome === 'ALREADY_APPLIED') await page.close().catch(() => undefined)
    return outcome
  }

  async scanSearch(profileId: string, source: string, pagesLimit: number, reportProgress?: SearchScanProgressReporter): Promise<{ authorization: AuthorizationCheckResult; vacancies: SearchVacancy[] | null }> {
    const url = normalizeSearchUrl(source)
    const authorization = await this.checkAuthorization(profileId)
    if (authorization.status !== 'AUTHORIZED') return { authorization, vacancies: null }
    const profilePage = this.#authorizationPage
    const context = this.#context
    if (!profilePage || !context || this.#activeProfileId !== profileId) throw new Error('Браузер аккаунта закрыт.')
    const resumes = await readResumeCards(profilePage)
    if (url.searchParams.has('resume') && !resumes.some((resume) => resume.hhResumeId === url.searchParams.get('resume'))) {
      throw new Error('Резюме поиска не найдено в текущем профиле HH. Проверьте, в какой аккаунт выполнен вход.')
    }
    let page = await this.#newBackgroundPage(context)
    this.#runtimePage = page
    try {
      let warningUrl: string | null = null
      const vacancies = await collectSearch(page, source, pagesLimit, reportProgress, loadHhSelectors(), report => {
        if (!this.#runtimeWarning) { this.#runtimeWarning = report; warningUrl = page.url() }
      }, async warningPage => {
        if (!this.#runtimeWarning || this.#runtimeWarning.tabId) return warningPage
        this.#runtimeWarning.tabId = this.#retainDiagnosticPage(warningPage)
        page = await this.#newBackgroundPage(context)
        this.#runtimePage = page
        return page
      })
      if (!this.#runtimeWarning || warningUrl !== page.url()) await page.close()
      return { authorization, vacancies }
    } catch (cause) {
      // Keep the page for manual login/captcha without changing window focus.
      if (cause instanceof SearchScanError) throw cause
      throw describeSearchScanFailure(cause, 'завершение сканирования')
    }
  }

  async apply(task: ApplicationTask, control: ApplicationControl): Promise<{ application: ApplicationOutcome; applicationBlocker?: ApplicationBlocker; vacancyPlainText?: string }> {
    let applicationBlocker: ApplicationBlocker | undefined
    let vacancyPlainText: string | undefined
    const application = await this.#apply(task, {
      ...control, block: reason => {
        applicationBlocker = reason
        if (reason === 'AUTH' || reason === 'CAPTCHA' || reason === 'BROWSER') this.#verifiedApplicationRun = null
      },
      vacancyText: text => { vacancyPlainText = text },
    })
    return {
      application,
      ...(applicationBlocker === undefined ? {} : { applicationBlocker }),
      ...(vacancyPlainText === undefined ? {} : { vacancyPlainText }),
    }
  }

  async collectVacancyText(task: ApplicationTask, allowed: () => Promise<boolean>): Promise<{
    application: ApplicationOutcome; vacancyPlainText?: string
  }> {
    if (!await allowed()) return { application: 'STOPPED' }
    if (!/^\d+$/.test(task.hhVacancyId)) return { application: 'TEXT_UNAVAILABLE' }
    const context = this.#context
    if (!context || this.#activeProfileId !== task.profileId) return { application: 'BROWSER_UNAVAILABLE' }
    const registry = loadHhSelectors()
    const page = await this.#newBackgroundPage(context)
    this.#runtimePage = page
    let preservePage = false
    let inspectFailure = false
    try {
      const expected = `https://hh.ru/vacancy/${task.hhVacancyId}`
      const response = await page.goto(expected, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      const barrier = await applicationBarrier(page, undefined, registry)
      if (barrier === 'AUTH' || barrier === 'CAPTCHA') {
        preservePage = true
        return { application: barrier }
      }
      if (response && [404, 410].includes(response.status())) return { application: 'VACANCY_UNAVAILABLE' }
      if (!response || response.status() >= 400 || !isVacancyDetailUrl(page.url(), expected))
        return { application: 'TEXT_UNAVAILABLE' }
      inspectFailure = true
      await page.locator(registry.locator('vacancy', 'title')).filter({ visible: true })
        .waitFor({ state: 'visible', timeout: 15_000 })
      if (await vacancyArchived(page, expected, registry)) { inspectFailure = false; return { application: 'VACANCY_ARCHIVED' } }
      const text = await extractVacancyText(page, task.hhVacancyId, registry)
      if (!await allowed()) { inspectFailure = false; return { application: 'STOPPED' } }
      if (text?.trim()) inspectFailure = false
      return text?.trim() ? { application: 'TEXT_LOADED', vacancyPlainText: text }
        : { application: 'TEXT_UNAVAILABLE' }
    } catch {
      const barrier = await applicationBarrier(page, undefined, registry).catch(() => null)
      if (barrier === 'AUTH' || barrier === 'CAPTCHA') {
        preservePage = true
        return { application: barrier }
      }
      return { application: 'TEXT_UNAVAILABLE' }
    } finally {
      if (!preservePage && inspectFailure) {
        const issue = await runtimeSelectorIssue(page)
        if (issue) { this.#runtimeWarning = issue; preservePage = true }
      }
      if (!preservePage) await page.close().catch(() => undefined)
    }
  }

  async #apply(task: ApplicationTask, control: ApplicationControl): Promise<ApplicationOutcome> {
    if (!await control.allowed()) return 'STOPPED'
    const context = this.#context
    if (!context || this.#activeProfileId !== task.profileId) return 'BROWSER_UNAVAILABLE'
    // Bind the profile/account check to the immutable run. The vacancy form is still checked
    // immediately before submission, while later items do not navigate back to the profile.
    if (!isApplicationRunVerified(this.#verifiedApplicationRun, task)) {
      const authorization = await this.checkAuthorization(task.profileId)
      if (authorization.status !== 'AUTHORIZED') {
        if (this.#authorizationPage) {
          const barrier = await applicationBarrier(this.#authorizationPage, control)
          if (barrier === 'CAPTCHA' || barrier === 'AUTH') return barrier
        }
        return authorization.status === 'REQUIRED' ? 'AUTH' : 'BROWSER_UNAVAILABLE'
      }
      const profile = this.#authorizationPage
      if (!profile || profile.isClosed()) return 'BROWSER_UNAVAILABLE'
      const resumes = await readResumeCards(profile)
      if (!resumes.some(resume => resume.hhResumeId === task.hhResumeId)) return 'RESUME_NOT_FOUND'
      this.#verifiedApplicationRun = verifiedApplicationRun(task)
    }
    if (!await control.allowed()) return 'STOPPED'
    const page = await this.#newBackgroundPage(context)
    this.#runtimePage = page
    const outcome = await applyVacancy(page, task, control)
    if (outcome === 'AUTH' || outcome === 'CAPTCHA' || outcome === 'BROWSER_UNAVAILABLE') {
      this.#verifiedApplicationRun = null
    }
    // Preserve unresolved forms for manual inspection; never close the user's existing tabs.
    if (outcome === 'SENT' || outcome === 'ALREADY_APPLIED') {
      await page.close().catch(() => undefined)
      this.#applicationPages.delete(task.hhVacancyId)
    } else {
      for (const [id, existing] of this.#applicationPages) if (existing.isClosed()) this.#applicationPages.delete(id)
      this.#applicationPages.set(task.hhVacancyId, page)
    }
    return outcome
  }

  async #launch(payload: OpenBrowserCommandPayload): Promise<void> {
    const profileDirectory = join(this.#config.profilesRootDirectory, payload.profileId)
    await mkdir(profileDirectory, { recursive: true })

    console.info(`[browser-agent] Opening Google Chrome profile: ${profileDirectory}`)

    const context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chrome',
      timeout: this.#config.launchTimeoutMs,
      headless: false,
      viewport: null,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: this.#config.disableGpu ? ['--start-maximized', '--disable-gpu'] : ['--start-maximized'],
    })

    try {
      if (process.env.HH_CLICKER_ASSESSMENT_ASSISTANT_ENABLED !== 'false') {
        await installAssessmentAssistant(context)
        await installCodeAssistant(context)
      }
    } catch (error) {
      await context.close().catch(() => undefined)
      throw error
    }

    context.once('close', () => {
      if (this.#context === context) {
        this.#context = null
        this.#activeProfileId = null
        this.#authorizationPage = null
        this.#verifiedApplicationRun = null
        this.#applicationPages.clear()
        this.#diagnosticPages.clear()
        this.#diagnosticChoices.clear()
        this.#fullDiagnostic = null
      }
    })

    this.#context = context
    this.#activeProfileId = payload.profileId

    if (context.pages().length === 0) {
      await context.newPage()
    }
  }
}
