import { isApplicationContextUrl } from '../hh/application-evidence.js'

interface VacancyTab {
  isClosed(): boolean
  url(): string
  bringToFront(): Promise<void>
}

/** Explicit user navigation only: never create, reload, or navigate a tab here. */
export async function focusVacancyTab(pages: readonly VacancyTab[], expectedUrl: string, preferred?: VacancyTab): Promise<void> {
  const target = new URL(expectedUrl)
  const id = target.pathname.match(/^\/vacancy\/([0-9]{1,20})$/)?.[1]
  if (target.origin !== 'https://hh.ru' || !id) throw new Error('Некорректная ссылка вакансии.')
  const matches = (page: VacancyTab): boolean => {
    try { return !page.isClosed() && isApplicationContextUrl(page.url(), target.href, id) }
    catch { return false }
  }
  const retainedBarrier = (page: VacancyTab): boolean => {
    try {
      const url = new URL(page.url())
      return !page.isClosed() && url.origin === target.origin
        && (/^\/(?:account\/login|auth\/applicant)(?:\/|$)/.test(url.pathname) || /captcha/i.test(url.pathname))
    } catch { return false }
  }
  const page = preferred && pages.includes(preferred) && (matches(preferred) || retainedBarrier(preferred))
    ? preferred : [...pages].reverse().find(matches)
  if (!page) throw new Error('Вкладка вакансии уже закрыта или перешла на другую страницу. Скопируйте ссылку для ручного открытия.')
  try { await page.bringToFront() }
  catch { throw new Error('Не удалось переключиться на вкладку Chrome. Проверьте окно браузера.') }
}
