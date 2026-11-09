import type { Page } from 'playwright'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'

export interface DiscoveredResume {
  hhResumeId: string
  name: string
  plainText?: string
}

export async function readResumeCards(page: Page, registry?: SelectorRegistry): Promise<DiscoveredResume[]> {
  try {
    const selectors = registry ?? loadHhSelectors()
    const root = page.locator(selectors.locator('profile', 'root'))
    const heading = root.locator(selectors.locator('profile', 'resumeSection'))
    const cardLocator = root.locator(selectors.locator('profile', 'resumeCards'))
    await heading.waitFor({ state: 'visible', timeout: 10_000 })
    // Заголовок может появиться раньше карточек при клиентской загрузке.
    await cardLocator.first()
      .waitFor({ state: 'attached', timeout: 3_000 }).catch(() => undefined)
    // Читаем только карточки, не initial state, контакты и содержимое резюме.
    const count = await cardLocator.count()
    if (count > 100) throw new Error('Too many cards')
    const cards: { href: string | null; title: string | null }[] = []
    for (let index = 0; index < count; index++) {
      const card = cardLocator.nth(index)
      const link = card.locator(selectors.locator('profile', 'resumeLink')).first()
      const title = card.locator(selectors.locator('profile', 'resumeTitle')).first()
      cards.push({
        href: await link.count() ? await link.getAttribute('href') : null,
        title: await card.getAttribute('data-qa-title') || (await title.count() ? await title.textContent() : null),
      })
    }
    const profileUrl = new URL(page.url())
    if (profileUrl.protocol !== 'https:' || !(profileUrl.hostname === 'hh.ru' || profileUrl.hostname.endsWith('.hh.ru'))
      || profileUrl.pathname.replace(/\/$/, '') !== '/applicant/profile/me') throw new Error('Profile navigation changed')
    if (!await heading.isVisible()) throw new Error('Resume section disappeared')
    if (!cards.length && await root.locator(selectors.locator('profile', 'anyResumeLink')).count() > 0) throw new Error('Resume card markup changed')
    const results = new Map<string, DiscoveredResume>()
    for (const card of cards) {
      const url = new URL(card.href ?? '', profileUrl)
      const hash = url.pathname.match(/^\/resume\/([a-f0-9]{20,100})\/?$/)?.[1]
      if (!hash || url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))) {
        throw new Error('Unrecognized resume link')
      }
      const name = (card.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      if (!name) throw new Error('Missing resume title')
      results.set(hash, { hhResumeId: hash, name })
    }
    return [...results.values()]
  } catch {
    // Не включаем сырые ошибки Playwright с данными страницы в результат команды.
    throw new Error('Не удалось прочитать список резюме. Проверьте вкладку профиля HH и повторите поиск.')
  }
}
