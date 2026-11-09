import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import { detectDiagnosticPage } from '../hh/selector-diagnostics.js'

/** Opaque handles refer to existing pages only; no title, query string or DOM leaves Chrome. */
export class DiagnosticPages {
  readonly #pages = new Map<string, Page>()

  list(pages: Page[]): { tabId: string; label: string }[] {
    this.#pages.clear()
    const labels = { PROFILE: 'Профиль', RESUME: 'Печатное резюме', SEARCH: 'Поиск', VACANCY: 'Вакансия' }
    return pages.filter(page => !page.isClosed()).slice(0, 200).map((page, index) => {
      const tabId = randomUUID()
      this.#pages.set(tabId, page)
      const type = detectDiagnosticPage(page.url())
      let suffix = ''
      try { suffix = new URL(page.url()).pathname.match(/^\/vacancy\/(\d{1,20})\/?$/)?.[1] ?? '' } catch { /* Unknown page. */ }
      return { tabId, label: `${index + 1}. ${type ? labels[type] : 'Другая страница'}${suffix ? ` №${suffix}` : ''}` }
    })
  }

  selected(tabId: string | null | undefined, pages: Page[]): Page {
    const page = tabId ? this.#pages.get(tabId) : undefined
    if (!page || page.isClosed() || !pages.includes(page))
      throw new Error('Выбранная вкладка закрыта или список устарел. Обновите список вкладок.')
    return page
  }

  clear(): void { this.#pages.clear() }
  get(tabId: string): Page | undefined { return this.#pages.get(tabId) }
}
