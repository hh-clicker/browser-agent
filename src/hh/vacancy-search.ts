import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
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

const CARD = '[data-qa="vacancy-serp__vacancy"]'

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

async function assertSearchPage(page: Page, expected: URL): Promise<void> {
  const actual = new URL(page.url())
  if (/captcha/i.test(actual.pathname)
      || await page.locator('[data-qa*="captcha" i], iframe[src*="captcha" i], .smart-captcha').filter({ visible: true }).count()
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
  if (!await page.locator('[data-qa="applicantProfileDesktopDrop-button"], [data-qa="applicantProfileMobileDrop-button"]').filter({ visible: true }).count()) {
    throw new SearchScanError('Не удалось подтвердить вход на странице поиска. Проверьте браузер.')
  }
  const currentPages = await page.locator('[data-qa="pager-block"] [aria-current="true"], [data-qa="pager-block"] [aria-current="page"]')
    .evaluateAll((nodes) => nodes.map((node) => node.closest('a')?.getAttribute('href')).filter(Boolean))
  if (currentPages.some((href) => (new URL(href!, actual).searchParams.get('page') ?? '0') !== expected.searchParams.get('page'))) {
    throw new SearchScanError('HH показал другой номер страницы выдачи. Повторите сканирование позже.')
  }
}

async function readCards(page: Page): Promise<SearchVacancy[]> {
  const raw = await page.locator(CARD).evaluateAll((cards) => cards.map((card) => {
    // Keep page callbacks self-contained: named local functions get a Node-only __name
    // helper from tsx/esbuild. Inline these reads so serialization cannot capture that helper.
    // The salary span contains <data> numbers and currency. Experience uses <data> too,
    // so select the compensation block explicitly, without versioned Magritte classes.
    const compensation = card.querySelector('[class*="compensation-labels--"]')
    const salaryNode = compensation ? Array.from(compensation.children).find((node) => node.tagName === 'SPAN' && node.querySelector('data')) : undefined
    const salaryText = (salaryNode?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const numbers = Array.from(salaryNode?.querySelectorAll('data[value]') ?? [])
      .map((node) => node.getAttribute('value') ?? '').filter((value) => /^\d+$/.test(value)).map(Number)
    const currency = salaryNode?.querySelector('data[value="RUB"]') ? 'RUR' : null
    const knownTaxes = /на руки|до вычета налогов/i.test(salaryText)
    const salary = currency && numbers.length && /за месяц/i.test(salaryText) && knownTaxes ? {
      from: /^до\s/i.test(salaryText) ? null : numbers[0] ?? null,
      to: numbers.length > 1 ? numbers[1] ?? null : /^до\s/i.test(salaryText) ? numbers[0] ?? null : null,
      currency, gross: /до вычета налогов/i.test(salaryText),
    } : null
    const labels = Array.from(card.querySelectorAll('[data-qa^="vacancy-label-"], [data-qa^="vacancy-serp__vacancy-compensation-frequency-"]'))
      .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    return {
      href: card.querySelector('[data-qa="serp-item__title"]')?.getAttribute('href'),
      employerHref: card.querySelector('[data-qa="vacancy-serp__vacancy-employer"]')?.getAttribute('href'),
      responseHref: card.querySelector('[data-qa="vacancy-serp__vacancy_response"]')?.getAttribute('href'),
      title: (card.querySelector('[data-qa="serp-item__title"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      companyName: (card.querySelector('[data-qa="vacancy-serp__vacancy-employer-text"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      location: (card.querySelector('[data-qa="vacancy-serp__vacancy-address"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      experience: (card.querySelector('[data-qa^="vacancy-serp__vacancy-work-experience-"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      workFormat: (card.querySelector('[data-qa="vacancy-label-work-schedule-remote"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      salaryText, salary, labels,
    }
  }))
  if (raw.length > 100) throw new SearchScanError('HH вернул неожиданное число карточек. Сканирование остановлено.')
  const cards = raw.map((card, position) => {
    const url = new URL(card.href ?? '', page.url())
    const hhVacancyId = url.pathname.match(/^\/vacancy\/(\d+)\/?$/)?.[1]
    if (!hhVacancyId || url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
        || !card.title || !card.companyName) throw new SearchScanError('Не удалось распознать обязательные поля карточки вакансии.')
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
  const initialState = await page.locator('#HH-Lux-InitialState').evaluate((node) => {
    try {
      const content = node instanceof HTMLTemplateElement ? node.content.textContent : node.textContent
      return content ? JSON.parse(content) : null
    } catch { return null }
  }).catch(() => null)
  const enrichments = vacancyEnrichmentFromInitialState(cards.map((card) => card.hhVacancyId), initialState)
  return cards.map((card, index) => enrichments ? { ...card, ...enrichments[index] } : card)
}

export async function collectSearch(page: Page, source: string, pagesLimit: number, reportProgress?: SearchScanProgressReporter): Promise<SearchVacancy[]> {
  const progress = { stage: 'подготовка поиска', pageNumber: 0 }
  try {
    return await collectSearchPages(page, source, pagesLimit, progress, reportProgress)
  } catch (cause) {
    throw describeSearchScanFailure(cause, progress.stage, progress.pageNumber)
  }
}

async function collectSearchPages(page: Page, source: string, pagesLimit: number, progress: { stage: string; pageNumber: number }, reportProgress?: SearchScanProgressReporter): Promise<SearchVacancy[]> {
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
    let fingerprint = ''
    let stable = 0
    let ready = false
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const snapshot = await page.locator(`${CARD}, [data-qa="pager-block"]`).evaluateAll((nodes) => nodes.map((node) => ({
        qa: node.getAttribute('data-qa'), text: node.textContent,
        links: Array.from(node.querySelectorAll('a[href]')).map((link) => link.getAttribute('href')),
      })))
      const hasCards = snapshot.some((node) => node.qa === 'vacancy-serp__vacancy')
      const next = JSON.stringify(snapshot)
      stable = next === fingerprint && hasCards ? stable + 1 : 0
      fingerprint = next
      if (stable >= 5) { ready = true; break }
      if (!hasCards && await page.getByText(/по вашему запросу (?:ничего не найдено|не найдено вакансий)/i).first().isVisible()) {
        progress.stage = 'проверка страницы'
        await assertSearchPage(page, url)
        await reportProgress?.({ currentPage: 1, totalPages: 1, collected: 0, totalResults: 0 })
        return [...result.values()]
      }
      await delay(500)
    }
    progress.stage = 'проверка страницы'
    await assertSearchPage(page, url)
    if (!ready) throw new SearchScanError('Выдача не загрузилась или изменилась разметка HH. Пустой результат не сохранён.')
    progress.stage = 'чтение карточек'
    const cards = await readCards(page)
    const ids = cards.map((card) => card.hhVacancyId).join(',')
    if (!cards.length || fingerprints.has(ids)) throw new SearchScanError('HH повторил страницу выдачи. Повторите сканирование позже.')
    fingerprints.add(ids)
    cards.forEach((card, index) => {
      if (!result.has(card.hhVacancyId)) result.set(card.hhVacancyId, { ...card, position: pageIndex * 100 + index })
    })
    if (totalResults === null) totalResults = await readTotalResults(page)
    progress.stage = 'чтение пагинации'
    const pages = await page.locator('[data-qa="pager-block"] a[href]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
    const hasNext = pages.some((href) => {
      if (!href) return false
      const target = new URL(href, url)
      return target.origin === url.origin && target.pathname === url.pathname
        && Number(target.searchParams.get('page')) > pageIndex
    })
    progress.stage = 'проверка страницы после чтения'
    await assertSearchPage(page, url)
    if (totalResults !== null && totalResults < result.size) totalResults = null
    const totalPages = searchScanTotalPages(totalResults, pagesLimit, pageIndex + 1, hasNext)
    await reportProgress?.({
      currentPage: pageIndex + 1,
      totalPages,
      collected: result.size,
      totalResults,
    })
    if (!hasNext) return [...result.values()]
    await delay(1500)
  }
  return [...result.values()]
}

async function readTotalResults(page: Page): Promise<number | null> {
  return page.locator('#HH-Lux-InitialState').evaluate((node) => {
    try {
      const content = node instanceof HTMLTemplateElement ? node.content.textContent : node.textContent
      return content ? JSON.parse(content) : null
    } catch { return null }
  }).then(searchTotalResultsFromInitialState).catch(() => null)
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
