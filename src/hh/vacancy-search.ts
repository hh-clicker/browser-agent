import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'
import { waitForStableSearch } from './search-stability.js'
import { describeSearchScanFailure, SearchScanError } from './search-scan-error.js'
import { vacancyEnrichmentFromInitialState, type SearchVacancyEnrichment } from './vacancy-search-enrichment.js'

export interface SearchVacancy {
  hhVacancyId: string
  title: string
  employerId: string | null
  companyName: string
  salaryText: string
  salary: { from: number | null; to: number | null; currency: string; gross: boolean } | null
  location: string
  workFormat: string
  experience: string
  labels: string[]
  position: number
  publishedAt: string | null
  enrichment: SearchVacancyEnrichment | null
}

export interface SearchScanProgress {
  currentPage: number
  totalPages: number
  collected: number
  totalResults: number | null
}

export type SearchScanProgressReporter = (progress: SearchScanProgress) => Promise<void> | void
export type SearchWarningReporter = (report: import('./selector-diagnostics.js').SelectorDiagnosticReport) => void


export function normalizeSearchUrl(source: string): URL {
  const url = new URL(source)
  if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
      || url.username || url.password || url.port || url.pathname !== '/search/vacancy'
      || url.searchParams.getAll('resume').length > 1
      || (url.searchParams.has('resume') && !url.searchParams.get('resume')?.trim())) {
    throw new SearchScanError('Некорректная ссылка поиска HH.')
  }
  url.hash = ''
  url.searchParams.set('items_on_page', '100')
  url.searchParams.set('page', '0')
  return url
}

async function assertSearchPage(page: Page, expected: URL, registry: SelectorRegistry): Promise<void> {
  const actual = new URL(page.url())
  if (/captcha/i.test(actual.pathname)
      || await page.locator(registry.locator('common', 'searchChallenge')).filter({ visible: true }).count()
      || await page.getByText(/пройдите капчу|подтвердите,? что вы не робот/i).first().isVisible()) {
    throw new SearchScanError('HH запросил проверку безопасности. Пройдите её в браузере и повторите сканирование.')
  }
  if (/\/(account\/login|auth\/applicant)/.test(actual.pathname)) {
    throw new SearchScanError('HH запросил вход. Авторизуйтесь в браузере и повторите сканирование.')
  }
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname
      || [...new Set(expected.searchParams.keys())].filter((key) => key !== 'page' && key !== 'search_session_id' && !key.startsWith('hhtm'))
        .some((key) => JSON.stringify(actual.searchParams.getAll(key).sort()) !== JSON.stringify(expected.searchParams.getAll(key).sort()))
      || (actual.searchParams.get('page') ?? '0') !== expected.searchParams.get('page')) {
    throw new SearchScanError('Страница поиска изменилась. Во время сканирования не меняйте фильтры в рабочей вкладке.')
  }
  if (!await page.locator(registry.locator('search', 'accountMenu')).filter({ visible: true }).count()) {
    throw new SearchScanError('Не удалось подтвердить вход на странице поиска. Проверьте браузер.')
  }
  const currentPages = await page.locator(registry.locator('search', 'pager')).locator(registry.locator('search', 'currentPage'))
    .evaluateAll((nodes) => nodes.map((node) => node.closest('a')?.getAttribute('href')).filter(Boolean))
  if (currentPages.some((href) => (new URL(href!, actual).searchParams.get('page') ?? '0') !== expected.searchParams.get('page'))) {
    throw new SearchScanError('HH показал другой номер страницы выдачи. Повторите сканирование позже.')
  }
}

export async function readSearchCards(page: Page, registry: SelectorRegistry = loadHhSelectors(), warnings?: SearchWarningReporter): Promise<SearchVacancy[]> {
  const definitions = registry.repairContext('search').group.selectors
  const raw = await page.locator(registry.locator('search', 'cards')).evaluateAll((cards, definitions) => cards.map(card => {
    // Resolve within each card, including XPath overrides, in one browser round trip.
    // These inline callbacks must remain independent of tsx's Node-only __name helper.
    const fields: Record<string, Element[]> = {}
    for (const key of ['title','employerLink','responseLink','employerName','location','experience','remote','labels',
      'salaryContainer','salarySpan','salaryValues','rubleCurrency']) {
      const definition = definitions[key]!
      const roots = key === 'salarySpan' ? (fields.salaryContainer ?? []).slice(0, 1)
        : key === 'salaryValues' || key === 'rubleCurrency' ? (fields.salarySpan ?? []).slice(0, 1) : [card]
      fields[key] = []
      for (const root of roots) {
        if (definition.kind === 'css') fields[key]!.push(...root.querySelectorAll(definition.value))
        else {
          const result = document.evaluate(definition.value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
          for (let index = 0; index < result.snapshotLength; index++) {
            const node = result.snapshotItem(index)
            if (node instanceof Element) fields[key]!.push(node)
          }
        }
      }
    }
    const salaryText = (fields.salarySpan?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const numbers = (fields.salaryValues ?? []).map(node => node.getAttribute('value') ?? '')
      .filter(value => /^\d+$/.test(value)).map(Number)
    const currency = fields.rubleCurrency?.length ? 'RUR' : null
    const knownTaxes = /на руки|до вычета налогов/i.test(salaryText)
    const cardText = (card as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const salary = currency && numbers.length && /за месяц/i.test(salaryText) && knownTaxes ? {
      from: /^до\s/i.test(salaryText) ? null : numbers[0] ?? null,
      to: numbers.length > 1 ? numbers[1] ?? null : /^до\s/i.test(salaryText) ? numbers[0] ?? null : null,
      currency, gross: /до вычета налогов/i.test(salaryText),
    } : null
    return {
      cardText,
      // Independent visible text gives a reason to suspect a missed optional field;
      // absence across cards alone is not evidence of a broken selector.
      missedFields: [
        !salaryText && /\d[\d\s]*\s*(?:₽|руб\.?|USD|EUR|RUB|\$|€)/i.test(cardText) ? 'salarySpan' : '',
        salaryText && /\d/.test(salaryText) && /за месяц/i.test(salaryText) && /₽|руб/i.test(salaryText)
          && !numbers.length ? 'salaryValues' : '',
        salaryText && /₽|руб/i.test(salaryText) && !fields.rubleCurrency?.length ? 'rubleCurrency' : '',
        !fields.experience?.length && /без опыта|опыт.{0,30}(?:лет|год)|\d\s*[–—-]\s*\d\s*(?:лет|год)/i.test(cardText) ? 'experience' : '',
        !fields.remote?.length && /удал[её]нн/i.test(cardText) ? 'remote' : '',
        !fields.labels?.length && /выплаты.{0,30}(?:раз|месяц|недел)|отклик без резюме/i.test(cardText) ? 'labels' : '',
        !fields.employerLink?.length && [...card.querySelectorAll('a[href]')].some(anchor => {
          try { const link = new URL(anchor.getAttribute('href')!, location.href); return link.origin === location.origin && /^\/employer\/\d+\/?$/.test(link.pathname) }
          catch { return false }
        }) ? 'employerLink' : '',
      ].filter(Boolean),
      invalidRequired: fields.title?.length !== 1 || fields.employerName?.length !== 1,
      href: fields.title?.[0]?.getAttribute('href'),
      employerHref: fields.employerLink?.[0]?.getAttribute('href'),
      responseHref: fields.responseLink?.[0]?.getAttribute('href'),
      title: (fields.title?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      companyName: (fields.employerName?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      location: (fields.location?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      experience: (fields.experience?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      workFormat: (fields.remote?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      salaryText, salary, labels: (fields.labels ?? []).map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    }
  }), definitions)
  if (raw.length > 100) throw new SearchScanError('HH вернул неожиданное число карточек. Сканирование остановлено.')
  const cards = raw.map((card, position) => {
    const url = new URL(card.href ?? '', page.url())
    const hhVacancyId = url.pathname.match(/^\/vacancy\/(\d+)\/?$/)?.[1]
    if (!hhVacancyId || url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
        || card.invalidRequired || !card.title || !card.companyName) throw new SearchScanError('Не удалось распознать обязательные поля карточки вакансии.')
    let employerId: string | null = null
    if (card.employerHref) {
      const employerUrl = new URL(card.employerHref, page.url())
      if (employerUrl.origin !== url.origin) throw new SearchScanError('Неожиданная ссылка работодателя.')
      employerId = employerUrl.pathname.match(/^\/employer\/(\d+)\/?$/)?.[1] ?? null
    }
    if (!employerId && card.responseHref) {
      const responseUrl = new URL(card.responseHref, page.url())
      if (responseUrl.origin === url.origin) {
        const id = responseUrl.searchParams.get('employerId')
        if (id && /^\d+$/.test(id)) employerId = id
      }
    }
    return { hhVacancyId, title: card.title, employerId, companyName: card.companyName,
      salaryText: card.salaryText, salary: card.salary, location: card.location, workFormat: card.workFormat,
      experience: card.experience, labels: [...new Set(card.labels)], position, publishedAt: null, enrichment: null }
  })
  const initialState = await readSearchInitialState(page, registry)
  const enrichments = vacancyEnrichmentFromInitialState(cards.map((card) => card.hhVacancyId), initialState)
  const missing = [...new Set(raw.flatMap((card, index) => {
    const address = enrichments?.[index]?.enrichment.address?.replace(/\s+/g, ' ').trim()
    return !card.location && address && card.cardText.includes(address) ? [...card.missedFields, 'location'] : card.missedFields
  }))]
  if (warnings && missing.length) warnings({
    pageType: 'SEARCH', status: 'CHECKED', summary: 'FAILED', checkedAt: new Date().toISOString(),
    message: 'Некоторые дополнительные поля карточек могли быть прочитаны не полностью. Это предупреждение не останавливает сбор вакансий.',
    rows: missing.map(key => ({ group: 'search', key, purpose: definitions[key]!.purpose,
      selector: registry.locator('search', key), source: registry.source('search', key), required: false,
      status: 'FAIL', matched: 0, visible: 0,
      message: 'В тексте карточки есть признаки данных, но селектор поля их не прочитал. Требуется точечная проверка страницы.' })),
  })
  return cards.map((card, index) => enrichments ? { ...card, ...enrichments[index] } : card)
}

async function readSearchInitialState(page: Page, registry: SelectorRegistry): Promise<unknown> {
  const target = page.locator(registry.locator('search', 'initialState'))
  if (await target.count() !== 1) return null
  return target.evaluate((node) => {
    try {
      const content = node instanceof HTMLTemplateElement ? node.content.textContent : node.textContent
      return content ? JSON.parse(content) : null
    } catch { return null }
  }).catch(() => null)
}

export async function collectSearch(page: Page, source: string, pagesLimit: number, reportProgress?: SearchScanProgressReporter, registry: SelectorRegistry = loadHhSelectors(), warnings?: SearchWarningReporter,
    continueAfterWarning?: (page: Page) => Promise<Page>): Promise<SearchVacancy[]> {
  const progress = { stage: 'подготовка поиска', pageNumber: 0 }
  try {
    return await collectSearchPages(page, source, pagesLimit, progress, reportProgress, registry, warnings, continueAfterWarning)
  } catch (cause) {
    throw describeSearchScanFailure(cause, progress.stage, progress.pageNumber)
  }
}

async function collectSearchPages(page: Page, source: string, pagesLimit: number, progress: { stage: string; pageNumber: number }, reportProgress?: SearchScanProgressReporter, registry: SelectorRegistry = loadHhSelectors(), warnings?: SearchWarningReporter,
    continueAfterWarning?: (page: Page) => Promise<Page>): Promise<SearchVacancy[]> {
  if (!Number.isInteger(pagesLimit) || pagesLimit < 1 || pagesLimit > 20) throw new SearchScanError('Недопустимый лимит страниц.')
  const url = normalizeSearchUrl(source)
  const result = new Map<string, SearchVacancy>()
  const fingerprints = new Set<string>()
  let totalResults: number | null = null
  for (let pageIndex = 0; pageIndex < pagesLimit; pageIndex++) {
    progress.pageNumber = pageIndex + 1
    progress.stage = 'загрузка выдачи'
    url.searchParams.set('page', String(pageIndex))
    const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (!response || response.status() >= 400) throw new SearchScanError('HH не загрузил выдачу. Проверьте вкладку и повторите сканирование.')
    // DOM remains authoritative. HH-Lux-InitialState is used only when its ordered ids match these settled cards.
    progress.stage = 'ожидание карточек'
    const settled = await waitForStableSearch(page, registry, { timeoutMs: 45_000 })
    if (settled === 'EMPTY') {
      await assertSearchPage(page, url, registry)
      await reportProgress?.({ currentPage: 1, totalPages: 1, collected: 0, totalResults: 0 })
      return [...result.values()]
    }
    const ready = settled === 'STABLE'
    progress.stage = 'проверка страницы'
    await assertSearchPage(page, url, registry)
    if (!ready) throw new SearchScanError('Выдача не загрузилась или изменилась разметка HH. Пустой результат не сохранён.')
    progress.stage = 'чтение карточек'
    let hasWarning = false
    const cards = await readSearchCards(page, registry, warning => { hasWarning = true; warnings?.(warning) })
    const ids = cards.map((card) => card.hhVacancyId).join(',')
    if (!cards.length || fingerprints.has(ids)) throw new SearchScanError('HH повторил страницу выдачи. Повторите сканирование позже.')
    fingerprints.add(ids)
    cards.forEach((card, index) => {
      if (!result.has(card.hhVacancyId)) result.set(card.hhVacancyId, { ...card, position: pageIndex * 100 + index })
    })
    if (totalResults === null) totalResults = await readTotalResults(page, registry)
    progress.stage = 'чтение пагинации'
    const pages = await page.locator(registry.locator('search', 'pager')).locator(registry.locator('search', 'pageLinks')).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
    const hasNext = pages.some((href) => {
      if (!href) return false
      const target = new URL(href, url)
      return target.origin === url.origin && target.pathname === url.pathname
        && Number(target.searchParams.get('page')) > pageIndex
    })
    progress.stage = 'проверка страницы после чтения'
    await assertSearchPage(page, url, registry)
    if (totalResults !== null && totalResults < result.size) totalResults = null
    const totalPages = searchScanTotalPages(totalResults, pagesLimit, pageIndex + 1, hasNext)
    await reportProgress?.({
      currentPage: pageIndex + 1,
      totalPages,
      collected: result.size,
      totalResults,
    })
    if (!hasNext) return [...result.values()]
    if (hasWarning && continueAfterWarning) page = await continueAfterWarning(page)
    await delay(1500)
  }
  return [...result.values()]
}

async function readTotalResults(page: Page, registry: SelectorRegistry): Promise<number | null> {
  return readSearchInitialState(page, registry).then(searchTotalResultsFromInitialState).catch(() => null)
}

export function searchTotalResultsFromInitialState(state: unknown): number | null {
  if (!state || typeof state !== 'object' || !('vacancySearchResult' in state)) return null
  const searchResult = state.vacancySearchResult
  if (!searchResult || typeof searchResult !== 'object' || !('totalResults' in searchResult)) return null
  const total = searchResult.totalResults
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null
}

export function searchScanTotalPages(totalResults: number | null, pagesLimit: number, currentPage: number, hasNext: boolean): number {
  if (!hasNext) return currentPage
  const estimated = totalResults === null ? pagesLimit : Math.max(currentPage, Math.max(1, Math.ceil(totalResults / 100)))
  return Math.min(pagesLimit, estimated)
}
