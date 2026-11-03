import { setTimeout as delay } from 'node:timers/promises'
import type { Locator, Page } from 'playwright'
import { isApplicationContextUrl, isExplicitLetterSuccess, isLetterPayload, isVacancyDetailUrl } from './application-evidence.js'
import { extractVacancyText } from './vacancy-text.js'
import type { AiLetterSettings, PreparedLetter } from '../generation/cover-letter.js'

export interface ApplicationTask {
  mode?: 'APPLY' | 'DRY_RUN'
  itemId: string
  runId: string
  profileId: string
  hhResumeId: string
  hhVacancyId: string
  sourceUrl: string
  searchPage: number
  coverLetter: string
  aiLetter?: AiLetterSettings
  resumePlainText?: string | null
  aiFallbackConfirmed?: boolean
  generationAttempt?: number
}
export type ApplicationOutcome = 'SENT' | 'SENT_LETTER_UNCONFIRMED' | 'SENT_LETTER_REJECTED_ALREADY_VIEWED'
  | 'ALREADY_APPLIED' | 'QUESTIONNAIRE'
  | 'LETTER_REQUIRED' | 'RESUME_UNAVAILABLE' | 'RESUME_NOT_FOUND' | 'VACANCY_UNAVAILABLE' | 'VACANCY_ARCHIVED'
  | 'BROWSER_UNAVAILABLE' | 'CAPTCHA' | 'AUTH' | 'UNKNOWN' | 'NOT_SENT' | 'STOPPED'
  | 'TEXT_LOADED' | 'TEXT_UNAVAILABLE'
export type ApplicationBlocker = 'AUTH' | 'CAPTCHA' | 'BROWSER' | 'RESUME'
export interface ApplicationControl {
  allowed(): Promise<boolean>
  permit(): Promise<boolean>
  block?(reason: ApplicationBlocker): void
  vacancyText?(plainText: string): void
  prepareLetter?(plainText: string | null): Promise<PreparedLetter | null>
}

const RESPONSE_FORM = 'form#RESPONSE_MODAL_FORM_ID[name="vacancy_response"]'
const LETTER = '[data-qa="vacancy-response-popup-form-letter-input"]'
const QUESTION = '[data-qa="employer-asking-for-test"], [data-qa="task-body"], [data-qa="task-question"]'
const CHALLENGE = '[data-qa*="captcha" i], iframe[src*="captcha" i], .g-recaptcha, .smart-captcha'
const DETAIL_ACTIONS = '.vacancy-actions_magritte-vacancy-top'
// The delivery notice belongs to this detail, never to a recommended vacancy.
const DETAIL_DELIVERED = '.vacancy-actions_responded:not([data-qa="vacancy-serp__vacancy"] *):not([data-qa="vacancy-view-vacancies-from-search"] *)'
const ATTACH_LETTER = '[data-qa="responded-success-attach-cover-letter"]'
const LETTER_REJECTED_ALREADY_VIEWED = /^Отклик уже просмотрен работодателем\.?$/i

export async function applicationBarrier(page: Page, control?: ApplicationControl): Promise<'CAPTCHA' | 'AUTH' | 'NOT_SENT' | null> {
  if (page.isClosed()) { control?.block?.('BROWSER'); return 'NOT_SENT' }
  const url = new URL(page.url())
  if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))) return 'NOT_SENT'
  if (/captcha/i.test(url.pathname) || await page.locator(CHALLENGE).filter({ visible: true }).count()
      || await page.getByText(/пройдите капчу|подтвердите,? что вы не робот/i).first().isVisible()) {
    control?.block?.('CAPTCHA'); return 'CAPTCHA'
  }
  if (/^\/(account\/login|auth\/applicant)(\/|$)/.test(url.pathname)) {
    control?.block?.('AUTH'); return 'AUTH'
  }
  return null
}

/** Reads the vacancy detail without clicking any response control. */
export async function inspectApplication(page: Page, sourceUrl: string): Promise<ApplicationOutcome> {
  try {
    const expected = new URL(sourceUrl)
    if (expected.origin !== 'https://hh.ru' || !/^\/vacancy\/\d+$/.test(expected.pathname)) return 'NOT_SENT'
    const response = await page.goto(expected.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    const barrier = await applicationBarrier(page)
    if (barrier) return barrier
    if (response && [404, 410].includes(response.status())) return 'VACANCY_UNAVAILABLE'
    if (!response || response.status() >= 400 || !isVacancyDetailUrl(page.url(), expected.href)) return 'NOT_SENT'
    await page.locator('h1[data-qa="vacancy-title"]').filter({ visible: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    if (await detailResponded(page, expected)) return 'ALREADY_APPLIED'
    if (await vacancyArchived(page, expected.href)) return 'VACANCY_ARCHIVED'
    if (await page.locator(QUESTION).filter({ visible: true }).count()) return 'QUESTIONNAIRE'
    return 'NOT_SENT'
  } catch {
    return await applicationBarrier(page).catch(() => null) ?? 'NOT_SENT'
  }
}

/** Executes one snapshotted vacancy. No retry of a click that could have submitted an application. */
export async function applyVacancy(page: Page, task: ApplicationTask, control: ApplicationControl): Promise<ApplicationOutcome> {
  let mayHaveSent = false
  let confirmed = false
  let deadline = Date.now() + 150_000
  try {
    if (!/^\d+$/.test(task.hhVacancyId) || !/^[a-zA-Z0-9]+$/.test(task.hhResumeId)) return 'NOT_SENT'
    // Search URL/page remain historical metadata only. The queue addresses the vacancy itself.
    const expected = new URL(`https://hh.ru/vacancy/${task.hhVacancyId}`)
    if (!await control.allowed()) return 'STOPPED'
    const response = await page.goto(expected.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    const barrier = await applicationBarrier(page, control)
    if (barrier) return barrier
    if (response && [404, 410].includes(response.status())) return 'VACANCY_UNAVAILABLE'
    if (!response || response.status() >= 400) return 'NOT_SENT'

    if (!isVacancyDetailUrl(page.url(), expected.href)) return 'NOT_SENT'
    const title = page.locator('h1[data-qa="vacancy-title"]').filter({ visible: true })
    await title.waitFor({ state: 'visible', timeout: 15_000 })
    const vacancyTitle = normalizeText(await title.innerText())
    if (!vacancyTitle || await page.locator('[role="dialog"]').filter({ visible: true }).count()) return 'NOT_SENT'
    // An archived detail is never a source of text; a confirmed earlier application still wins.
    const alreadyApplied = await detailResponded(page, expected)
    if (await vacancyArchived(page, expected.href)) return alreadyApplied ? 'ALREADY_APPLIED' : 'VACANCY_ARCHIVED'
    const plainText = await extractVacancyText(page, task.hhVacancyId)
    if (plainText !== null) control.vacancyText?.(plainText)
    if (alreadyApplied || await detailResponded(page, expected)) return 'ALREADY_APPLIED'
    // Recommendations use serp buttons. Never click those or "respond with another resume".
    const respond = page.locator(`${DETAIL_ACTIONS} [data-qa="vacancy-response-link-top"]`).filter({ visible: true })
    if (await respond.count() !== 1) return 'NOT_SENT'
    const responseHref = await respond.getAttribute('href')
    if (!responseHref) return 'NOT_SENT'
    const responseUrl = new URL(responseHref, expected)
    if (responseUrl.origin !== expected.origin || responseUrl.pathname !== '/applicant/vacancy_response'
        || responseUrl.searchParams.getAll('vacancyId').length !== 1
        || responseUrl.searchParams.get('vacancyId') !== task.hhVacancyId) return 'NOT_SENT'

    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    if (control.prepareLetter) {
      const prepared = await control.prepareLetter(plainText)
      if (!prepared || prepared.source === 'RATE_LIMIT' || prepared.source === 'AI_FAILED') return 'STOPPED'
      task = { ...task, coverLetter: prepared.text }
      // Generation has its own bounded wait; keep the HH interaction budget separate.
      deadline = Date.now() + 150_000
    } else if (task.aiLetter?.enabled) return 'NOT_SENT'
    if (task.coverLetter.includes('#AI_CHANGE#')) return 'NOT_SENT'
    if (await applicationBarrier(page, control)) return 'NOT_SENT'
    if (await detailResponded(page, expected)) return 'ALREADY_APPLIED'
    // Treat even the initial button as potentially submitting (HH can skip the popup).
    // Persist the uncertainty guard BEFORE contacting HH; never retry a lost permit response.
    mayHaveSent = true
    if (!await control.permit()) { mayHaveSent = false; return 'STOPPED' }
    if (!await control.allowed() || Date.now() >= deadline) { mayHaveSent = false; return 'STOPPED' }
    if (!isVacancyDetailUrl(page.url(), expected.href)) { mayHaveSent = false; return 'NOT_SENT' }
    await respond.click({ timeout: 5000 })

    let state = await waitForResponse(page, expected, task.hhVacancyId, control)
    if (state === 'SENT') {
      confirmed = true
      if (!task.coverLetter) return 'SENT'
      return await attachLetter(page, expected, task.coverLetter, control, deadline)
    }
    if (state === 'QUESTIONNAIRE') { mayHaveSent = false; return state }
    if (state !== 'FORM') {
      if (await reloadAndConfirmDelivery(page, expected, control)) {
        console.info('[application] Delivery confirmed after detail reload')
        confirmed = true
        if (!task.coverLetter) return 'SENT'
        return await attachLetter(page, expected, task.coverLetter, control, deadline)
      }
      return 'UNKNOWN'
    }
    // A visible, identified response form means the initial click did not submit.
    mayHaveSent = false
    const dialog = page.locator('[role="dialog"]').filter({ has: page.locator(RESPONSE_FORM), visible: true })
    if (await dialog.count() !== 1 || !normalizeText(await dialog.innerText()).includes(vacancyTitle)) return 'NOT_SENT'
    const form = dialog.locator(RESPONSE_FORM)
    if (!await control.allowed()) return 'STOPPED'
    if (!await selectResume(page, form, task.hhResumeId)) return 'RESUME_UNAVAILABLE'
    if (await form.locator('[data-qa="hidden-resume-warning"]').isVisible()) return 'RESUME_UNAVAILABLE'
    if (await page.locator(QUESTION).filter({ visible: true }).count()) return 'QUESTIONNAIRE'
    const required = /сопроводительное\s+письмо\s+обязательн/i.test(normalizeText(await dialog.innerText()))
    if (required && !task.coverLetter) return 'LETTER_REQUIRED'
    if (task.coverLetter) {
      if (!await control.allowed()) return 'STOPPED'
      if (!await form.locator(LETTER).isVisible()) {
        // HH renders this button in the dialog footer, outside the response form.
        const addLetter = dialog.locator('[data-qa="add-cover-letter"]')
        if (!await addLetter.isVisible()) return 'NOT_SENT'
        await addLetter.click({ timeout: 5000 })
      }
      await form.locator(LETTER).fill(task.coverLetter, { timeout: 5000 })
    } else if (await form.locator(LETTER).isVisible()) {
      // Do not send a remembered HH draft when the user chose an empty letter.
      await form.locator(LETTER).fill('', { timeout: 5000 })
    }
    const submit = dialog.locator('[data-qa="vacancy-response-submit-popup"][form="RESPONSE_MODAL_FORM_ID"]')
    if (!await submit.isEnabled() || !await submit.isVisible()) return 'NOT_SENT'
    if (await applicationBarrier(page, control) || !isApplicationContextUrl(page.url(), expected.href, task.hhVacancyId)
        || !normalizeText(await dialog.innerText()).includes(vacancyTitle)) return 'NOT_SENT'
    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    // Re-check the selection before submitting; a selectable resume is verified by hash.
    if (!await selectedResumeIs(page, form, task.hhResumeId)) return 'RESUME_UNAVAILABLE'
    if (await form.locator('[data-qa="hidden-resume-warning"]').isVisible()) return 'RESUME_UNAVAILABLE'
    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    if (await applicationBarrier(page, control) || !isApplicationContextUrl(page.url(), expected.href, task.hhVacancyId)) return 'NOT_SENT'
    if (task.coverLetter && await form.locator(LETTER).inputValue() !== task.coverLetter) return 'NOT_SENT'
    mayHaveSent = true
    await submit.click({ timeout: 5000 })
    state = await waitForResponse(page, expected, task.hhVacancyId, control, false)
    if (state === 'SENT') { confirmed = true; return 'SENT' }
    if (await reloadAndConfirmDelivery(page, expected, control)) {
      console.info('[application] Delivery confirmed after detail reload')
      confirmed = true
      return 'SENT'
    }
    return 'UNKNOWN'
  } catch {
    // Never leak page HTML, cookies or raw Playwright logs into the result.
    await applicationBarrier(page, control).catch(() => undefined)
    return confirmed ? 'SENT_LETTER_UNCONFIRMED' : mayHaveSent ? 'UNKNOWN' : 'NOT_SENT'
  }
}

function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim() }

export async function vacancyArchived(page: Page, expectedUrl: string): Promise<boolean> {
  if (!isVacancyDetailUrl(page.url(), expectedUrl)) return false
  const title = page.locator('h1[data-qa="vacancy-title"]').filter({ visible: true })
  if (await title.count() !== 1) return false
  return await title.locator('[data-qa="vacancy-title-archived-text"]').filter({ visible: true }).count() === 1
    || await page.locator('[data-qa="vacancy-archive-description"]').filter({ visible: true }).count() === 1
}

async function detailResponded(page: Page, expected: URL): Promise<boolean> {
  if (!isVacancyDetailUrl(page.url(), expected.href)) return false
  if (await page.locator('h1[data-qa="vacancy-title"]').filter({ visible: true }).count() !== 1) return false
  // With only one available resume HH can submit immediately and omit "other resume".
  // The persistent delivery notice + chat also confirms that the response was delivered.
  const delivered = page.locator(DETAIL_DELIVERED).filter({ visible: true })
  if (await delivered.count() === 1
      && await delivered.getByText('Резюме доставлено', { exact: true }).isVisible()
      && await delivered.locator('[data-qa="vacancy-response-link-view-topic"]').filter({ visible: true }).count() === 1) return true
  const actions = page.locator(DETAIL_ACTIONS).filter({ visible: true })
  if (await actions.count() !== 1) return false
  return await actions.locator('[data-qa="vacancy-response-link-top-again"]').isVisible()
    && await actions.locator('[data-qa="vacancy-response-link-view-topic"]').isVisible()
    && !await actions.locator('[data-qa="vacancy-response-link-top"]').isVisible()
}

async function waitForResponse(page: Page, expected: URL, hhId: string, control: ApplicationControl, allowForm = true): Promise<'SENT' | 'FORM' | 'QUESTIONNAIRE' | 'UNKNOWN'> {
  const deadline = Date.now() + 15_000
  while (!page.isClosed() && Date.now() < deadline) {
    if (await applicationBarrier(page, control)) return 'UNKNOWN'
    if (!isApplicationContextUrl(page.url(), expected.href, hhId)) return 'UNKNOWN'
    if (await detailResponded(page, expected)) return 'SENT'
    if (allowForm) {
      if (await page.locator(QUESTION).filter({ visible: true }).count()) return 'QUESTIONNAIRE'
      if (await page.locator(RESPONSE_FORM).isVisible()) return 'FORM'
    }
    await delay(250)
  }
  if (page.isClosed()) control.block?.('BROWSER')
  return 'UNKNOWN'
}

async function reloadAndConfirmDelivery(page: Page, expected: URL, control: ApplicationControl): Promise<boolean> {
  if (page.isClosed() || !await control.allowed()) return false
  try {
    const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    if (response && response.status() >= 400) return false
    if (await applicationBarrier(page, control) || !isVacancyDetailUrl(page.url(), expected.href)) return false
    await page.locator('h1[data-qa="vacancy-title"]').filter({ visible: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    return await detailResponded(page, expected)
  } catch {
    await applicationBarrier(page, control).catch(() => undefined)
    return false
  }
}

function resumeTrigger(form: Locator): Locator {
  return form.locator('[data-qa="resume-title"]').locator('xpath=ancestor::*[@role="button"][1]')
}

async function resumeSelectionMode(form: Locator): Promise<'select' | 'fixed' | 'missing'> {
  const title = form.locator('[data-qa="resume-title"]')
  const trigger = resumeTrigger(form)
  if (await title.count() !== 1 || await trigger.count() !== 1 || !await trigger.isVisible()
      || await trigger.getAttribute('aria-disabled') === 'true') return 'missing'
  // HH keeps role="button" even for one fixed resume. Only the selectable variant
  // has a magritte-select-layout wrapper. The user is responsible for its availability.
  return await trigger.evaluate(element => !!element.closest('[class*="magritte-select-layout"]')) ? 'select' : 'fixed'
}

async function selectResume(page: Page, form: Locator, hash: string): Promise<boolean> {
  const mode = await resumeSelectionMode(form)
  if (mode !== 'select') return mode === 'fixed'
  const trigger = resumeTrigger(form)
  if (!await trigger.isVisible()) return false
  await trigger.click({ timeout: 5000 })
  const option = page.locator(`[role="listbox"] [role="option"][data-magritte-select-option="${hash}"]`)
  await page.locator('[data-qa="magritte-select-option-list"]').waitFor({ state: 'visible', timeout: 5000 })
  if (await option.count() !== 1 || await option.getAttribute('aria-disabled') === 'true') return false
  // HH leaves the dropdown open when its already-selected option is clicked.
  // Use the trigger to close it without changing the resume in that case.
  if (await option.getAttribute('aria-selected') === 'true') {
    await trigger.click({ timeout: 5000 })
  } else {
    await option.click({ timeout: 5000 })
  }
  await page.locator('[data-qa="magritte-select-option-list"]').waitFor({ state: 'hidden', timeout: 5000 })
  return selectedResumeIs(page, form, hash)
}

async function selectedResumeIs(page: Page, form: Locator, hash: string): Promise<boolean> {
  const mode = await resumeSelectionMode(form)
  if (mode !== 'select') return mode === 'fixed'
  await resumeTrigger(form).click({ timeout: 5000 })
  const list = page.locator('[data-qa="magritte-select-option-list"]')
  await list.waitFor({ state: 'visible', timeout: 5000 })
  const selected = list.locator('[role="option"][aria-selected="true"]')
  const correct = await selected.count() === 1 && await selected.getAttribute('data-magritte-select-option') === hash
  // Close via the trigger: re-clicking the selected option does not close HH's list.
  await resumeTrigger(form).click({ timeout: 5000 })
  await list.waitFor({ state: 'hidden', timeout: 5000 })
  return correct
}

async function attachLetter(page: Page, expected: URL, letter: string, control: ApplicationControl, deadline: number): Promise<ApplicationOutcome> {
  if (!await control.allowed() || Date.now() >= deadline) return 'SENT_LETTER_UNCONFIRMED'
  if (await applicationBarrier(page, control) || !await detailResponded(page, expected)) return 'SENT_LETTER_UNCONFIRMED'
  const toggle = page.locator(`${DETAIL_DELIVERED} ${ATTACH_LETTER}`).filter({ visible: true })
  if (await toggle.count() !== 1) return 'SENT_LETTER_UNCONFIRMED'
  await toggle.click({ timeout: 5000 })
  const dialog = page.locator('[role="dialog"]').filter({ visible: true,
    has: page.locator('form[action="/applicant/vacancy_response/edit_ajax"]') })
  const form = dialog.locator('form[action="/applicant/vacancy_response/edit_ajax"]')
  await form.waitFor({ state: 'visible', timeout: 5000 })
  if (await dialog.count() !== 1 || await form.count() !== 1) return 'SENT_LETTER_UNCONFIRMED'
  const formId = await form.getAttribute('id')
  const topic = form.locator('input[name="topicId"]')
  if (!formId || await topic.count() !== 1) return 'SENT_LETTER_UNCONFIRMED'
  const topicId = await topic.inputValue()
  if (!/^\d+$/.test(topicId)) return 'SENT_LETTER_UNCONFIRMED'
  await form.locator(LETTER).fill(letter, { timeout: 5000 })
  if (!await control.allowed() || Date.now() >= deadline || await applicationBarrier(page, control)
      || !await detailResponded(page, expected)) return 'SENT_LETTER_UNCONFIRMED'
  const submit = dialog.locator('[data-qa="vacancy-response-letter-submit"]')
  if (await submit.count() !== 1 || await submit.getAttribute('form') !== formId
      || await form.locator(LETTER).inputValue() !== letter) return 'SENT_LETTER_UNCONFIRMED'
  // Register before clicking so a quick response cannot be missed. This observes only;
  // it never sends/replays a request, and a timeout is not permission to retry.
  const observed = page.waitForResponse(async response => {
    const request = response.request()
    const url = new URL(response.url())
    return url.origin === expected.origin && url.pathname === '/applicant/vacancy_response/edit_ajax'
      && request.method() === 'POST' && request.frame() === page.mainFrame()
      && await isLetterPayload(request.headers()['content-type'] ?? '', request.postData(), topicId, letter)
  }, { timeout: 15_000 }).catch(() => null)
  await submit.click({ timeout: 5000 })
  // Network evidence is supplementary. HH returns both boolean true and string "true".
  // A missing/unfamiliar response must not veto the agreed persistent detail UI evidence.
  void observed.then(async response => {
    if (!response?.ok()) return
    const payload: unknown = await response.json().catch(() => null)
    if (isExplicitLetterSuccess(payload)) console.info('[application] Letter request acknowledged')
  }).catch(() => undefined)
  const until = Math.min(deadline, Date.now() + 15_000)
  while (!page.isClosed() && Date.now() < until) {
    if (await applicationBarrier(page, control)) return 'SENT_LETTER_UNCONFIRMED'
    if (await dialog.getByText(LETTER_REJECTED_ALREADY_VIEWED).filter({ visible: true }).count()) {
      return 'SENT_LETTER_REJECTED_ALREADY_VIEWED'
    }
    if (!await detailResponded(page, expected)) return 'SENT_LETTER_UNCONFIRMED'
    if (!await dialog.isVisible()) {
      if (!await page.locator(`${DETAIL_DELIVERED} ${ATTACH_LETTER}`).filter({ visible: true }).count()
          && await page.locator(DETAIL_DELIVERED).getByText('Резюме доставлено', { exact: true }).isVisible()) return 'SENT'
      if (await reloadAndConfirmLetter(page, expected, control)) {
        console.info('[application] Letter attachment confirmed after detail reload')
        return 'SENT'
      }
      return 'SENT_LETTER_UNCONFIRMED'
    }
    await delay(100)
  }
  if (page.isClosed()) control.block?.('BROWSER')
  if (await reloadAndConfirmLetter(page, expected, control)) {
    console.info('[application] Letter attachment confirmed after detail reload')
    return 'SENT'
  }
  return 'SENT_LETTER_UNCONFIRMED'
}

async function reloadAndConfirmLetter(page: Page, expected: URL, control: ApplicationControl): Promise<boolean> {
  if (!await reloadAndConfirmDelivery(page, expected, control)) return false
  return !await page.locator(`${DETAIL_DELIVERED} ${ATTACH_LETTER}`).filter({ visible: true }).count()
}
