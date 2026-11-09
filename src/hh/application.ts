import { setTimeout as delay } from 'node:timers/promises'
import type { Locator, Page } from 'playwright'
import { isApplicationContextUrl, isExplicitLetterSuccess, isLetterPayload, isVacancyDetailUrl } from './application-evidence.js'
import { extractVacancyText } from './vacancy-text.js'
import { ClickObstructedError, ensureClickReady } from './click-readiness.js'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'
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

// The delivery notice belongs to this detail, never to a recommended vacancy.
const LETTER_REJECTED_ALREADY_VIEWED = /^Отклик уже просмотрен работодателем\.?$/i

export async function applicationBarrier(page: Page, control?: ApplicationControl, registry: SelectorRegistry = loadHhSelectors()): Promise<'CAPTCHA' | 'AUTH' | 'NOT_SENT' | null> {
  if (page.isClosed()) { control?.block?.('BROWSER'); return 'NOT_SENT' }
  const url = new URL(page.url())
  if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))) return 'NOT_SENT'
  if (/captcha/i.test(url.pathname) || await page.locator(registry.locator('common', 'challenge')).filter({ visible: true }).count()
      || await page.getByText(/пройдите капчу|подтвердите,? что вы не робот/i).first().isVisible()) {
    control?.block?.('CAPTCHA'); return 'CAPTCHA'
  }
  if (/^\/(account\/login|auth\/applicant)(\/|$)/.test(url.pathname)) {
    control?.block?.('AUTH'); return 'AUTH'
  }
  return null
}

/** Reads the vacancy detail without clicking any response control. */
export async function inspectApplication(page: Page, sourceUrl: string, registry: SelectorRegistry = loadHhSelectors()): Promise<ApplicationOutcome> {
  try {
    const expected = new URL(sourceUrl)
    if (expected.origin !== 'https://hh.ru' || !/^\/vacancy\/\d+$/.test(expected.pathname)) return 'NOT_SENT'
    const response = await page.goto(expected.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    const barrier = await applicationBarrier(page, undefined, registry)
    if (barrier) return barrier
    if (response && [404, 410].includes(response.status())) return 'VACANCY_UNAVAILABLE'
    if (!response || response.status() >= 400 || !isVacancyDetailUrl(page.url(), expected.href)) return 'NOT_SENT'
    await page.locator(registry.locator('vacancy', 'title')).filter({ visible: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    if (await detailResponded(registry, page, expected)) return 'ALREADY_APPLIED'
    if (await vacancyArchived(page, expected.href, registry)) return 'VACANCY_ARCHIVED'
    if (await page.locator(registry.locator('vacancy', 'questionnaire')).filter({ visible: true }).count()) return 'QUESTIONNAIRE'
    return 'NOT_SENT'
  } catch {
    return await applicationBarrier(page, undefined, registry).catch(() => null) ?? 'NOT_SENT'
  }
}

/** Executes one snapshotted vacancy. No retry of a click that could have submitted an application. */
export async function applyVacancy(page: Page, task: ApplicationTask, control: ApplicationControl, registry: SelectorRegistry = loadHhSelectors()): Promise<ApplicationOutcome> {
  const originalControl = control
  const reportedBlockers = new Set<ApplicationBlocker>()
  control = { ...control, block: reason => {
    // Observation and recovery guards may see the same barrier repeatedly. Keep
    // every guard, but notify the queue once per reason for this vacancy.
    if (reportedBlockers.has(reason)) return
    reportedBlockers.add(reason)
    originalControl.block?.(reason)
  } }
  const recovery: ApplicationRecovery = { reloadUsed: false, deliveryConfirmed: false, permitGranted: false }
  for (;;) {
    try {
      const outcome = await applyVacancyAttempt(registry, page, task, control, recovery)
      return recovery.deliveryConfirmed && !['SENT', 'SENT_LETTER_UNCONFIRMED', 'SENT_LETTER_REJECTED_ALREADY_VIEWED'].includes(outcome)
        ? 'SENT_LETTER_UNCONFIRMED' : outcome
    }
    catch (error) {
      if (!(error instanceof ClickObstructedError)) throw error
      const barrier = await applicationBarrier(page, control, registry).catch(() => 'NOT_SENT' as const)
      if (barrier) return recovery.deliveryConfirmed ? 'SENT_LETTER_UNCONFIRMED' : barrier
      if (!await control.allowed().catch(() => false)) return recovery.deliveryConfirmed ? 'SENT_LETTER_UNCONFIRMED' : 'STOPPED'
      if (recovery.reloadUsed) return recovery.deliveryConfirmed ? 'SENT_LETTER_UNCONFIRMED' : 'NOT_SENT'
      recovery.reloadUsed = true
    }
  }
}

interface ApplicationRecovery {
  reloadUsed: boolean
  deliveryConfirmed: boolean
  permitGranted: boolean
  preparedLetter?: string
}

async function applyVacancyAttempt(registry: SelectorRegistry, page: Page, task: ApplicationTask, control: ApplicationControl,
    recovery: ApplicationRecovery): Promise<ApplicationOutcome> {
  if (recovery.preparedLetter !== undefined) task = { ...task, coverLetter: recovery.preparedLetter }
  let mayHaveSent = false
  let confirmed = recovery.deliveryConfirmed
  let deadline = Date.now() + 150_000
  try {
    if (!/^\d+$/.test(task.hhVacancyId) || !/^[a-zA-Z0-9]+$/.test(task.hhResumeId)) return 'NOT_SENT'
    // Search URL/page remain historical metadata only. The queue addresses the vacancy itself.
    const expected = new URL(`https://hh.ru/vacancy/${task.hhVacancyId}`)
    if (!await control.allowed()) return 'STOPPED'
    if (recovery.reloadUsed && !isApplicationContextUrl(page.url(), expected.href, task.hhVacancyId))
      return recovery.deliveryConfirmed ? 'SENT_LETTER_UNCONFIRMED' : 'NOT_SENT'
    const response = recovery.reloadUsed && isVacancyDetailUrl(page.url(), expected.href)
      ? await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
      : await page.goto(expected.href, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    const barrier = await applicationBarrier(page, control, registry)
    if (barrier) return barrier
    if (response && [404, 410].includes(response.status())) return 'VACANCY_UNAVAILABLE'
    if (!response || response.status() >= 400) return 'NOT_SENT'

    if (!isVacancyDetailUrl(page.url(), expected.href)) return 'NOT_SENT'
    const title = page.locator(registry.locator('vacancy', 'title')).filter({ visible: true })
    await title.waitFor({ state: 'visible', timeout: 15_000 })
    const vacancyTitle = normalizeText(await title.innerText())
    if (!vacancyTitle) return 'NOT_SENT'
    // An archived detail is never a source of text; a confirmed earlier application still wins.
    const alreadyApplied = await detailResponded(registry, page, expected)
    if (await vacancyArchived(page, expected.href, registry)) return alreadyApplied ? 'ALREADY_APPLIED' : 'VACANCY_ARCHIVED'
    const plainText = await extractVacancyText(page, task.hhVacancyId, registry)
    if (plainText !== null) control.vacancyText?.(plainText)
    if (alreadyApplied || await detailResponded(registry, page, expected)) {
      if (!recovery.deliveryConfirmed) return 'ALREADY_APPLIED'
      return task.coverLetter ? await attachLetter(registry, page, expected, task.coverLetter, control, deadline) : 'SENT'
    }
    if (recovery.deliveryConfirmed) return 'SENT_LETTER_UNCONFIRMED'
    // Recommendations use serp buttons. Never click those or "respond with another resume".
    const respond = page.locator(registry.locator('vacancy', 'actions')).locator(registry.locator('vacancy', 'respond')).filter({ visible: true })
    if (await respond.count() !== 1) return 'NOT_SENT'
    const responseHref = await respond.getAttribute('href')
    if (!responseHref) return 'NOT_SENT'
    const responseUrl = new URL(responseHref, expected)
    if (responseUrl.origin !== expected.origin || responseUrl.pathname !== '/applicant/vacancy_response'
        || responseUrl.searchParams.getAll('vacancyId').length !== 1
        || responseUrl.searchParams.get('vacancyId') !== task.hhVacancyId) return 'NOT_SENT'
    if (!await ensureClickReady(respond)) return 'NOT_SENT'
    if (await page.locator(registry.locator('responseForm', 'dialog')).filter({ visible: true }).count()) return 'NOT_SENT'

    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    if (control.prepareLetter && recovery.preparedLetter === undefined) {
      const prepared = await control.prepareLetter(plainText)
      if (!prepared || prepared.source === 'RATE_LIMIT' || prepared.source === 'AI_FAILED') return 'STOPPED'
      task = { ...task, coverLetter: prepared.text }
      recovery.preparedLetter = prepared.text
      // Generation has its own bounded wait; keep the HH interaction budget separate.
      deadline = Date.now() + 150_000
    } else if (task.aiLetter?.enabled && recovery.preparedLetter === undefined) return 'NOT_SENT'
    if (task.coverLetter.includes('#AI_CHANGE#')) return 'NOT_SENT'
    if (await applicationBarrier(page, control, registry)) return 'NOT_SENT'
    if (await detailResponded(registry, page, expected)) return 'ALREADY_APPLIED'
    if (!await ensureClickReady(respond)) return 'NOT_SENT'
    // Treat even the initial button as potentially submitting (HH can skip the popup).
    // Persist the uncertainty guard BEFORE contacting HH; never retry a lost permit response.
    mayHaveSent = true
    if (!recovery.permitGranted) {
      if (!await control.permit()) { mayHaveSent = false; return 'STOPPED' }
      recovery.permitGranted = true
    }
    if (!await control.allowed() || Date.now() >= deadline) { mayHaveSent = false; return 'STOPPED' }
    if (!isVacancyDetailUrl(page.url(), expected.href)) { mayHaveSent = false; return 'NOT_SENT' }
    await respond.click({ timeout: 5000 })

    let state = await waitForResponse(registry, page, expected, task.hhVacancyId, control)
    if (state === 'SENT') {
      confirmed = true
      recovery.deliveryConfirmed = true
      if (!task.coverLetter) return 'SENT'
      return await attachLetter(registry, page, expected, task.coverLetter, control, deadline)
    }
    if (state === 'QUESTIONNAIRE') { mayHaveSent = false; return state }
    if (state !== 'FORM') {
      if (await reloadAndConfirmDelivery(registry, page, expected, control)) {
        console.info('[application] Delivery confirmed after detail reload')
        confirmed = true
        recovery.deliveryConfirmed = true
        if (!task.coverLetter) return 'SENT'
        return await attachLetter(registry, page, expected, task.coverLetter, control, deadline)
      }
      return 'UNKNOWN'
    }
    // A visible, identified response form means the initial click did not submit.
    mayHaveSent = false
    const dialog = page.locator(registry.locator('responseForm', 'dialog')).filter({ has: page.locator(registry.locator('responseForm', 'form')), visible: true })
    if (await dialog.count() !== 1 || !normalizeText(await dialog.innerText()).includes(vacancyTitle)) return 'NOT_SENT'
    const form = dialog.locator(registry.locator('responseForm', 'form'))
    if (!await control.allowed()) return 'STOPPED'
    if (!await selectResume(registry, page, form, task.hhResumeId)) return 'RESUME_UNAVAILABLE'
    if (await form.locator(registry.locator('responseForm', 'hiddenResumeWarning')).isVisible()) return 'RESUME_UNAVAILABLE'
    if (await page.locator(registry.locator('vacancy', 'questionnaire')).filter({ visible: true }).count()) return 'QUESTIONNAIRE'
    const required = /сопроводительное\s+письмо\s+обязательн/i.test(normalizeText(await dialog.innerText()))
    if (required && !task.coverLetter) return 'LETTER_REQUIRED'
    if (task.coverLetter) {
      if (!await control.allowed()) return 'STOPPED'
      if (!await form.locator(registry.locator('responseForm', 'letter')).isVisible()) {
        // HH renders this button in the dialog footer, outside the response form.
        const addLetter = dialog.locator(registry.locator('responseForm', 'addLetter'))
        if (!await addLetter.isVisible()) return 'NOT_SENT'
        if (!await ensureClickReady(addLetter)) return 'NOT_SENT'
        await addLetter.click({ timeout: 5000 })
      }
      await form.locator(registry.locator('responseForm', 'letter')).fill(task.coverLetter, { timeout: 5000 })
    } else if (await form.locator(registry.locator('responseForm', 'letter')).isVisible()) {
      // Do not send a remembered HH draft when the user chose an empty letter.
      await form.locator(registry.locator('responseForm', 'letter')).fill('', { timeout: 5000 })
    }
    const submit = dialog.locator(registry.locator('responseForm', 'submit'))
    if (!await submit.isEnabled() || !await submit.isVisible()) return 'NOT_SENT'
    if (await applicationBarrier(page, control, registry) || !isApplicationContextUrl(page.url(), expected.href, task.hhVacancyId)
        || !normalizeText(await dialog.innerText()).includes(vacancyTitle)) return 'NOT_SENT'
    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    // Re-check the selection before submitting; a selectable resume is verified by hash.
    if (!await selectedResumeIs(registry, page, form, task.hhResumeId)) return 'RESUME_UNAVAILABLE'
    if (await form.locator(registry.locator('responseForm', 'hiddenResumeWarning')).isVisible()) return 'RESUME_UNAVAILABLE'
    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    if (await applicationBarrier(page, control, registry) || !isApplicationContextUrl(page.url(), expected.href, task.hhVacancyId)) return 'NOT_SENT'
    if (task.coverLetter && await form.locator(registry.locator('responseForm', 'letter')).inputValue() !== task.coverLetter) return 'NOT_SENT'
    if (!await ensureClickReady(submit)) return 'NOT_SENT'
    if (!await control.allowed() || Date.now() >= deadline) return 'STOPPED'
    if (await applicationBarrier(page, control, registry) || !isApplicationContextUrl(page.url(), expected.href, task.hhVacancyId)) return 'NOT_SENT'
    mayHaveSent = true
    await submit.click({ timeout: 5000 })
    state = await waitForResponse(registry, page, expected, task.hhVacancyId, control, false)
    if (state === 'SENT') { confirmed = true; return 'SENT' }
    if (await reloadAndConfirmDelivery(registry, page, expected, control)) {
      console.info('[application] Delivery confirmed after detail reload')
      confirmed = true
      return 'SENT'
    }
    return 'UNKNOWN'
  } catch (error) {
    if (error instanceof ClickObstructedError) throw error
    // Never leak page HTML, cookies or raw Playwright logs into the result.
    await applicationBarrier(page, control, registry).catch(() => undefined)
    return confirmed ? 'SENT_LETTER_UNCONFIRMED' : mayHaveSent ? 'UNKNOWN' : 'NOT_SENT'
  }
}

function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim() }

export async function vacancyArchived(page: Page, expectedUrl: string, registry: SelectorRegistry = loadHhSelectors()): Promise<boolean> {
  if (!isVacancyDetailUrl(page.url(), expectedUrl)) return false
  const title = page.locator(registry.locator('vacancy', 'title')).filter({ visible: true })
  if (await title.count() !== 1) return false
  return await title.locator(registry.locator('vacancy', 'archivedTitle')).filter({ visible: true }).count() === 1
    || await page.locator(registry.locator('vacancy', 'archivedDescription')).filter({ visible: true }).count() === 1
}

async function detailResponded(registry: SelectorRegistry, page: Page, expected: URL): Promise<boolean> {
  if (!isVacancyDetailUrl(page.url(), expected.href)) return false
  if (await page.locator(registry.locator('vacancy', 'title')).filter({ visible: true }).count() !== 1) return false
  // With only one available resume HH can submit immediately and omit "other resume".
  // The persistent delivery notice + chat also confirms that the response was delivered.
  const delivered = page.locator(registry.locator('vacancy', 'delivered')).filter({ visible: true })
  if (await delivered.count() === 1
      && await delivered.getByText('Резюме доставлено', { exact: true }).isVisible()
      && await delivered.locator(registry.locator('vacancy', 'viewResponse')).filter({ visible: true }).count() === 1) return true
  const actions = page.locator(registry.locator('vacancy', 'actions')).filter({ visible: true })
  if (await actions.count() !== 1) return false
  return await actions.locator(registry.locator('vacancy', 'respondAgain')).isVisible()
    && await actions.locator(registry.locator('vacancy', 'viewResponse')).isVisible()
    && !await actions.locator(registry.locator('vacancy', 'respond')).isVisible()
}

async function waitForResponse(registry: SelectorRegistry, page: Page, expected: URL, hhId: string, control: ApplicationControl, allowForm = true): Promise<'SENT' | 'FORM' | 'QUESTIONNAIRE' | 'UNKNOWN'> {
  const deadline = Date.now() + 15_000
  while (!page.isClosed() && Date.now() < deadline) {
    if (await applicationBarrier(page, control, registry)) return 'UNKNOWN'
    if (!isApplicationContextUrl(page.url(), expected.href, hhId)) return 'UNKNOWN'
    if (await detailResponded(registry, page, expected)) return 'SENT'
    if (allowForm) {
      if (await page.locator(registry.locator('vacancy', 'questionnaire')).filter({ visible: true }).count()) return 'QUESTIONNAIRE'
      if (await page.locator(registry.locator('responseForm', 'form')).isVisible()) return 'FORM'
    }
    await delay(250)
  }
  if (page.isClosed()) control.block?.('BROWSER')
  return 'UNKNOWN'
}

async function reloadAndConfirmDelivery(registry: SelectorRegistry, page: Page, expected: URL, control: ApplicationControl): Promise<boolean> {
  if (page.isClosed() || !await control.allowed()) return false
  try {
    if (await applicationBarrier(page, control, registry) || !isVacancyDetailUrl(page.url(), expected.href)) return false
    const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    if (response && response.status() >= 400) return false
    if (await applicationBarrier(page, control, registry) || !isVacancyDetailUrl(page.url(), expected.href)) return false
    await page.locator(registry.locator('vacancy', 'title')).filter({ visible: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    return await detailResponded(registry, page, expected)
  } catch {
    await applicationBarrier(page, control, registry).catch(() => undefined)
    return false
  }
}

function resumeTrigger(registry: SelectorRegistry, form: Locator): Locator {
  return form.locator(registry.locator('responseForm', 'resumeTitle')).locator(registry.locator('responseForm', 'resumeTrigger'))
}

async function resumeSelectionMode(registry: SelectorRegistry, form: Locator): Promise<'select' | 'fixed' | 'missing'> {
  const title = form.locator(registry.locator('responseForm', 'resumeTitle'))
  const trigger = resumeTrigger(registry, form)
  if (await title.count() !== 1 || await trigger.count() !== 1 || !await trigger.isVisible()
      || await trigger.getAttribute('aria-disabled') === 'true') return 'missing'
  // HH keeps role="button" even for one fixed resume. Only the selectable variant
  // has a magritte-select-layout wrapper. The user is responsible for its availability.
  const wrapper = registry.repairContext('responseForm').group.selectors.selectWrapper!
  return await trigger.evaluate((element, selector) => selector.kind === 'css'
    ? Boolean(element.closest(selector.value))
    : Boolean(document.evaluate(selector.value, element, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue), wrapper)
    ? 'select' : 'fixed'
}

async function selectResume(registry: SelectorRegistry, page: Page, form: Locator, hash: string): Promise<boolean> {
  const mode = await resumeSelectionMode(registry, form)
  if (mode !== 'select') return mode === 'fixed'
  const trigger = resumeTrigger(registry, form)
  if (!await trigger.isVisible()) return false
  if (!await ensureClickReady(trigger)) return false
  await trigger.click({ timeout: 5000 })
  await page.locator(registry.locator('responseForm', 'resumeList')).waitFor({ state: 'visible', timeout: 5000 })
  const options = page.locator(registry.locator('responseForm', 'resumeOptions'))
  const matches = await options.evaluateAll((nodes, expectedHash) => nodes.flatMap((node, index) =>
    node.getAttribute('data-magritte-select-option') === expectedHash ? [index] : []), hash)
  if (matches.length !== 1) return false
  const option = options.nth(matches[0]!)
  if (await option.getAttribute('data-magritte-select-option') !== hash) return false
  if (await option.count() !== 1 || await option.getAttribute('aria-disabled') === 'true') return false
  // HH leaves the dropdown open when its already-selected option is clicked.
  // Use the trigger to close it without changing the resume in that case.
  if (await option.getAttribute('aria-selected') === 'true') {
    if (!await ensureClickReady(trigger)) return false
    await trigger.click({ timeout: 5000 })
  } else {
    if (!await ensureClickReady(option)) return false
    await option.click({ timeout: 5000 })
  }
  await page.locator(registry.locator('responseForm', 'resumeList')).waitFor({ state: 'hidden', timeout: 5000 })
  return selectedResumeIs(registry, page, form, hash)
}

async function selectedResumeIs(registry: SelectorRegistry, page: Page, form: Locator, hash: string): Promise<boolean> {
  const mode = await resumeSelectionMode(registry, form)
  if (mode !== 'select') return mode === 'fixed'
  if (!await ensureClickReady(resumeTrigger(registry, form))) return false
  await resumeTrigger(registry, form).click({ timeout: 5000 })
  const list = page.locator(registry.locator('responseForm', 'resumeList'))
  await list.waitFor({ state: 'visible', timeout: 5000 })
  const selected = list.locator(registry.locator('responseForm', 'selectedResume'))
  const correct = await selected.count() === 1 && await selected.getAttribute('data-magritte-select-option') === hash
  // Close via the trigger: re-clicking the selected option does not close HH's list.
  if (!await ensureClickReady(resumeTrigger(registry, form))) return false
  await resumeTrigger(registry, form).click({ timeout: 5000 })
  await list.waitFor({ state: 'hidden', timeout: 5000 })
  return correct
}

async function attachLetter(registry: SelectorRegistry, page: Page, expected: URL, letter: string, control: ApplicationControl, deadline: number): Promise<ApplicationOutcome> {
  if (!await control.allowed() || Date.now() >= deadline) return 'SENT_LETTER_UNCONFIRMED'
  if (await applicationBarrier(page, control, registry) || !await detailResponded(registry, page, expected)) return 'SENT_LETTER_UNCONFIRMED'
  const toggle = page.locator(registry.locator('vacancy', 'delivered')).locator(registry.locator('letterForm', 'attach')).filter({ visible: true })
  if (await toggle.count() !== 1) return 'SENT_LETTER_UNCONFIRMED'
  if (!await ensureClickReady(toggle)) return 'SENT_LETTER_UNCONFIRMED'
  await toggle.click({ timeout: 5000 })
  const dialog = page.locator(registry.locator('letterForm', 'dialog')).filter({ visible: true,
    has: page.locator(registry.locator('letterForm', 'form')) })
  const form = dialog.locator(registry.locator('letterForm', 'form'))
  await form.waitFor({ state: 'visible', timeout: 5000 })
  if (await dialog.count() !== 1 || await form.count() !== 1) return 'SENT_LETTER_UNCONFIRMED'
  const formId = await form.getAttribute('id')
  const topic = form.locator(registry.locator('letterForm', 'topic'))
  if (!formId || await topic.count() !== 1) return 'SENT_LETTER_UNCONFIRMED'
  const topicId = await topic.inputValue()
  if (!/^\d+$/.test(topicId)) return 'SENT_LETTER_UNCONFIRMED'
  await form.locator(registry.locator('letterForm', 'letter')).fill(letter, { timeout: 5000 })
  if (!await control.allowed() || Date.now() >= deadline || await applicationBarrier(page, control, registry)
      || !await detailResponded(registry, page, expected)) return 'SENT_LETTER_UNCONFIRMED'
  const submit = dialog.locator(registry.locator('letterForm', 'submit'))
  if (await submit.count() !== 1 || await submit.getAttribute('form') !== formId
      || await form.locator(registry.locator('letterForm', 'letter')).inputValue() !== letter) return 'SENT_LETTER_UNCONFIRMED'
  if (!await ensureClickReady(submit)) return 'SENT_LETTER_UNCONFIRMED'
  if (!await control.allowed() || Date.now() >= deadline || await applicationBarrier(page, control, registry)
      || !await detailResponded(registry, page, expected)) return 'SENT_LETTER_UNCONFIRMED'
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
    if (await applicationBarrier(page, control, registry)) return 'SENT_LETTER_UNCONFIRMED'
    if (await dialog.getByText(LETTER_REJECTED_ALREADY_VIEWED).filter({ visible: true }).count()) {
      return 'SENT_LETTER_REJECTED_ALREADY_VIEWED'
    }
    if (!await detailResponded(registry, page, expected)) return 'SENT_LETTER_UNCONFIRMED'
    if (!await dialog.isVisible()) {
      if (!await page.locator(registry.locator('vacancy', 'delivered')).locator(registry.locator('letterForm', 'attach')).filter({ visible: true }).count()
          && await page.locator(registry.locator('vacancy', 'delivered')).getByText('Резюме доставлено', { exact: true }).isVisible()) return 'SENT'
      if (await reloadAndConfirmLetter(registry, page, expected, control)) {
        console.info('[application] Letter attachment confirmed after detail reload')
        return 'SENT'
      }
      return 'SENT_LETTER_UNCONFIRMED'
    }
    await delay(100)
  }
  if (page.isClosed()) control.block?.('BROWSER')
  if (await reloadAndConfirmLetter(registry, page, expected, control)) {
    console.info('[application] Letter attachment confirmed after detail reload')
    return 'SENT'
  }
  return 'SENT_LETTER_UNCONFIRMED'
}

async function reloadAndConfirmLetter(registry: SelectorRegistry, page: Page, expected: URL, control: ApplicationControl): Promise<boolean> {
  if (!await reloadAndConfirmDelivery(registry, page, expected, control)) return false
  return !await page.locator(registry.locator('vacancy', 'delivered')).locator(registry.locator('letterForm', 'attach')).filter({ visible: true }).count()
}
