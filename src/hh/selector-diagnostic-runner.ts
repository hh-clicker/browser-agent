import type { Page } from 'playwright'
import { diagnoseSelectors, finishDiagnostic, skippedDiagnostic, blockedDiagnostic, matchesDiagnosticPage, type DiagnosticPageType, type SelectorDiagnosticReport } from './selector-diagnostics.js'
import { HH_PROFILE_URL } from './authorization-check.js'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'
import { readResumeCards } from './resume-discovery.js'
import { offerSelectorRepair } from './selector-repair.js'

export interface SelectorDiagnosticTarget { hhResumeId: string | null; searchUrl: string | null; searchName: string | null; tabId?: string | null; repairGroup?: string | null }
interface DiagnosticPorts { createPage(): Promise<Page>; retainPage(page: Page): string }
export interface DiagnosticContinuation { previous: SelectorDiagnosticReport; repaired: SelectorDiagnosticReport; page: Page }

export function diagnosticSearchUrl(raw: string): string {
  const url = new URL(raw)
  if (!matchesDiagnosticPage(url.href, 'SEARCH') || url.username || url.password) throw new Error('INVALID_DIAGNOSTIC_SEARCH')
  url.searchParams.set('page', '0')
  return url.href
}

export async function firstDiagnosticVacancy(page: Page, registry: SelectorRegistry): Promise<string | null> {
  const links = page.locator(registry.locator('search','cards')).locator(registry.locator('search','title'))
  for (let index = 0; index < Math.min(await links.count(), 100); index++) {
    if (!await links.nth(index).isVisible()) continue
    const href = await links.nth(index).getAttribute('href')
    if (!href) continue
    try {
      const url = new URL(href, page.url())
      if (!url.username && !url.password && matchesDiagnosticPage(url.href, 'VACANCY')
        && /^\/vacancy\/[0-9]{1,20}\/?$/.test(url.pathname)) return url.href
    } catch { /* Try another visible card; never click. */ }
  }
  return null
}

/** Full read-only diagnostic. Each temporary tab is isolated from application tabs. */
export async function runFullSelectorDiagnostics(target: SelectorDiagnosticTarget, ports: DiagnosticPorts,
  registry: SelectorRegistry = loadHhSelectors(), continuation?: DiagnosticContinuation): Promise<SelectorDiagnosticReport> {
  const scenarios: SelectorDiagnosticReport[] = []
  const previous = continuation?.previous.scenarios?.map(step => structuredClone(step)) ?? []
  const cached = (type: DiagnosticPageType): SelectorDiagnosticReport | undefined => {
    if (!continuation || type !== continuation.repaired.pageType) return previous.find(step => step.pageType === type)
    const result = structuredClone(continuation.repaired)
    const contextLabel = previous.find(step => step.pageType === type)?.contextLabel
    if (contextLabel !== undefined) result.contextLabel = contextLabel
    return result
  }
  let resumeHash: string | null = null
  let vacancyUrl: string | null = null
  let barrier = false
  const visit = async (type: DiagnosticPageType, url: string, after?: (page: Page, report: SelectorDiagnosticReport) => Promise<void>) => {
    const old = cached(type)
    if (old && old.status !== 'BLOCKED') {
      if (old.status === 'LOGIN' || old.status === 'CAPTCHA') barrier = true
      if (after && continuation && continuation.repaired.pageType === type && old.status === 'CHECKED') {
        try { await after(continuation.page, old) }
        catch { old.status = 'PAGE_UNAVAILABLE'; old.message = 'Исправление сохранено, но не удалось подготовить зависимый шаг. Повторите диагностику.' }
        finishDiagnostic(old)
      }
      scenarios.push(old)
      return old
    }
    let page: Page | null = null
    let result: SelectorDiagnosticReport
    try {
      page = await ports.createPage()
      await page.route('**/*', route => ['image','media','font'].includes(route.request().resourceType()) ? route.abort() : route.fallback())
      await page.addInitScript(() => { window.print = () => {} })
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      const anchors: Record<DiagnosticPageType, [string, string]> = {
        PROFILE: ['profile','resumeSection'], RESUME: ['resumeText','ready'], SEARCH: ['search','cards'], VACANCY: ['vacancy','title'],
      }
      const [group, key] = anchors[type]
      await page.locator(registry.locator(group, key)).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
      result = await diagnoseSelectors(page, type, registry)
      if ((!response || response.status() >= 400) && result.status !== 'LOGIN' && result.status !== 'CAPTCHA') {
        result = finishDiagnostic({ ...result, status: 'PAGE_UNAVAILABLE', rows: [], message: 'HH не загрузил страницу для этого шага.' })
      }
      if (result.status === 'LOGIN' || result.status === 'CAPTCHA') barrier = true
      if (after && result.status === 'CHECKED') await after(page, result)
      finishDiagnostic(result)
      await offerSelectorRepair(page, result, registry)
    } catch {
      result = finishDiagnostic({ pageType: type, checkedAt: new Date().toISOString(), status: 'PAGE_UNAVAILABLE', rows: [],
        message: 'Не удалось открыть или проверить страницу. Сырые сетевые ошибки и содержимое страницы не сохраняются.' })
    }
    if (page && !page.isClosed()) {
      if (result.summary === 'PASSED') await page.close().catch(() => undefined)
      else result.tabId = ports.retainPage(page)
    }
    scenarios.push(result)
    return result
  }

  const profile = await visit('PROFILE', HH_PROFILE_URL, async (page, report) => {
    if (report.rows.some(row => row.required && row.status !== 'PASS')) return
    try {
      const resumes = await readResumeCards(page, registry)
      const chosen = target.hhResumeId ? resumes.find(item => item.hhResumeId === target.hhResumeId) : resumes[0]
      resumeHash = chosen?.hhResumeId ?? null
      if (!chosen) { report.status = 'SKIPPED'; report.message = 'Выбранное резюме не найдено среди резюме открытого HH-аккаунта.' }
    } catch { report.status = 'PAGE_UNAVAILABLE'; report.message = 'Не удалось прочитать ссылки резюме после проверки профиля.' }
  })
  const oldResume = cached('RESUME')
  if (oldResume && oldResume.status !== 'BLOCKED') scenarios.push(oldResume)
  else if (resumeHash && !barrier) await visit('RESUME', `https://hh.ru/resume/${resumeHash}?print=true`)
  else scenarios.push(profile.summary === 'FAILED' || profile.status === 'PAGE_UNAVAILABLE'
    ? blockedDiagnostic('RESUME', profile)
    : skippedDiagnostic('RESUME', 'Не удалось подготовить печатное резюме по результатам проверки профиля.'))

  if (barrier) scenarios.push(skippedDiagnostic('SEARCH', 'Сначала завершите вход или проверку безопасности HH.'))
  else if (!target.searchUrl) scenarios.push(skippedDiagnostic('SEARCH', 'Для выбранного резюме нет сохранённых поисков.'))
  else {
    try {
      const search = await visit('SEARCH', diagnosticSearchUrl(target.searchUrl), async (page, report) => {
        if (report.rows.some(row => ['cards','title'].includes(row.key) && row.status === 'FAIL')) return
        vacancyUrl = await firstDiagnosticVacancy(page, registry)
      })
      if (target.searchName) search.contextLabel = target.searchName.slice(0, 120)
    } catch { scenarios.push(skippedDiagnostic('SEARCH', 'Сохранённая ссылка поиска не подходит для диагностики.')) }
  }
  const oldVacancy = cached('VACANCY')
  if (oldVacancy && oldVacancy.status !== 'BLOCKED') scenarios.push(oldVacancy)
  else if (vacancyUrl && !barrier) await visit('VACANCY', vacancyUrl)
  else {
    const search = scenarios.find(step => step.pageType === 'SEARCH')
    scenarios.push(search && (search.summary === 'FAILED' || search.status === 'PAGE_UNAVAILABLE')
      ? blockedDiagnostic('VACANCY', search)
      : skippedDiagnostic('VACANCY', barrier ? 'Сначала завершите вход или проверку безопасности HH.'
      : search?.status === 'SKIPPED' ? 'Поиск не запускался; ссылку на вакансию получить неоткуда.'
        : search?.summary === 'PASSED' ? 'В проверенной выдаче нет доступной ссылки на вакансию; выдача может быть пустой.'
          : 'Проверка поиска не позволила получить корректную ссылку вакансии.'))
  }
  const report = finishDiagnostic({ pageType: 'FULL', checkedAt: new Date().toISOString(), status: 'CHECKED', rows: [], scenarios, message: '' })
  report.message = report.summary === 'PASSED' ? 'Все доступные сценарии чтения прошли проверку. Формы отклика автоматически не открывались.'
    : report.summary === 'FAILED' ? 'Обнаружены проблемы. Смотрите результаты отдельных сценариев.'
      : 'Полная диагностика выполнена частично. Для пропущенных шагов указаны причины.'
  return report
}
