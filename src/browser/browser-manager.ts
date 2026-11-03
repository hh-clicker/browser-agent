import { mkdir } from 'node:fs/promises'
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
import { isVacancyDetailUrl } from '../hh/application-evidence.js'
import { isApplicationRunVerified, verifiedApplicationRun, type VerifiedApplicationRun } from './application-run-verification.js'

import type { OpenBrowserCommandPayload } from '../backend/browser-agent-command.js'
import type { BrowserConfig } from '../config/browser-config.js'

export class BrowserManager {
  readonly #config: BrowserConfig
  #context: BrowserContext | null = null
  #activeProfileId: string | null = null
  #opening: Promise<void> | null = null
  #authorizationPage: Page | null = null
  #verifiedApplicationRun: VerifiedApplicationRun | null = null

  constructor(config: BrowserConfig) {
    this.#config = config
  }

  get isOpen(): boolean {
    return this.#context !== null
  }

  get activeProfileId(): string | null {
    return this.#activeProfileId
  }

  async open(payload: OpenBrowserCommandPayload): Promise<void> {
    if (this.#context) {
      if (this.#activeProfileId === payload.profileId) {
        const activePage = this.#context.pages().at(-1)
        if (activePage) await activePage.bringToFront()
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
    await context.close()
  }

  async checkAuthorization(profileId: string): Promise<AuthorizationCheckResult> {
    const context = this.#context
    if (!context || this.#activeProfileId !== profileId) throw new Error('Профиль браузера не запущен')

    if (!this.#authorizationPage || this.#authorizationPage.isClosed() || !this.#isAuthorizationPage(this.#authorizationPage)) {
      // Повторно используем только страницу профиля или пустую вкладку, не чужую открытую вакансию.
      this.#authorizationPage = context.pages().find((page) => page.url().split('?')[0] === HH_PROFILE_URL)
        ?? context.pages().find((page) => page.url() === 'about:blank')
        ?? await context.newPage()
    }
    const page = this.#authorizationPage
    await page.bringToFront()
    return checkAuthorization(page)
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
    const plainText = await readResumePrintText(this.#context, selected.hhResumeId)
    return { authorization, resumes: [{ ...selected, plainText }] }
  }

  async openUrl(profileId: string, url: string): Promise<void> {
    if (!this.#context || this.#activeProfileId !== profileId) {
      throw new Error('Профиль браузера не запущен')
    }

    const page = await this.#context.newPage()
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
    const page = await context.newPage()
    await page.bringToFront()
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
    const page = await context.newPage()
    await page.bringToFront()
    try {
      const vacancies = await collectSearch(page, source, pagesLimit, reportProgress)
      await page.close()
      return { authorization, vacancies }
    } catch (cause) {
      // Keep the page for manual login/captcha. Do not forward Playwright call logs or HTML.
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
    const page = await context.newPage()
    await page.bringToFront()
    let preservePage = false
    try {
      const expected = `https://hh.ru/vacancy/${task.hhVacancyId}`
      const response = await page.goto(expected, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      const barrier = await applicationBarrier(page)
      if (barrier === 'AUTH' || barrier === 'CAPTCHA') {
        preservePage = true
        return { application: barrier }
      }
      if (response && [404, 410].includes(response.status())) return { application: 'VACANCY_UNAVAILABLE' }
      if (!response || response.status() >= 400 || !isVacancyDetailUrl(page.url(), expected))
        return { application: 'TEXT_UNAVAILABLE' }
      await page.locator('h1[data-qa="vacancy-title"]').filter({ visible: true })
        .waitFor({ state: 'visible', timeout: 15_000 })
      if (await vacancyArchived(page, expected)) return { application: 'VACANCY_ARCHIVED' }
      const text = await extractVacancyText(page, task.hhVacancyId)
      if (!await allowed()) return { application: 'STOPPED' }
      return text?.trim() ? { application: 'TEXT_LOADED', vacancyPlainText: text }
        : { application: 'TEXT_UNAVAILABLE' }
    } catch {
      const barrier = await applicationBarrier(page).catch(() => null)
      if (barrier === 'AUTH' || barrier === 'CAPTCHA') {
        preservePage = true
        return { application: barrier }
      }
      return { application: 'TEXT_UNAVAILABLE' }
    } finally {
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
    const page = await context.newPage()
    await page.bringToFront()
    const outcome = await applyVacancy(page, task, control)
    if (outcome === 'AUTH' || outcome === 'CAPTCHA' || outcome === 'BROWSER_UNAVAILABLE') {
      this.#verifiedApplicationRun = null
    }
    // Preserve unresolved forms for manual inspection; never close the user's existing tabs.
    if (outcome === 'SENT' || outcome === 'ALREADY_APPLIED') await page.close().catch(() => undefined)
    return outcome
  }

  async #launch(payload: OpenBrowserCommandPayload): Promise<void> {
    const profileDirectory = join(this.#config.profilesRootDirectory, payload.profileId)
    await mkdir(profileDirectory, { recursive: true })

    console.info(`[browser-agent] Opening Google Chrome profile: ${profileDirectory}`)

    const context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chrome',
      timeout: 30_000,
      headless: false,
      viewport: null,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--start-maximized'],
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
      }
    })

    this.#context = context
    this.#activeProfileId = payload.profileId

    if (context.pages().length === 0) {
      await context.newPage()
    }
  }
}
