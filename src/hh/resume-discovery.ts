import type { Page } from 'playwright'

export interface DiscoveredResume {
  hhResumeId: string
  name: string
  plainText?: string
}

export async function readResumeCards(page: Page): Promise<DiscoveredResume[]> {
  try {
    const root = page.locator('.ResumeProfileFront-ReactRoot')
    await root.locator('[data-qa="compact-resume-title"]').waitFor({ state: 'visible', timeout: 10_000 })
    // Заголовок может появиться раньше карточек при клиентской загрузке.
    await root.locator('[data-qa~="resume"][data-qa-id]').first()
      .waitFor({ state: 'attached', timeout: 3_000 }).catch(() => undefined)
    // Читаем только карточки, не initial state, контакты и содержимое резюме.
    const cards = await root.locator('[data-qa~="resume"][data-qa-id]').evaluateAll((elements) => elements.map((card) => ({
      href: card.querySelector('a[data-qa^="resume-card-link-"][href]')?.getAttribute('href'),
      title: card.getAttribute('data-qa-title') || card.querySelector('[data-qa="resume-title"]')?.textContent,
    })))
    const profileUrl = new URL(page.url())
    if (profileUrl.protocol !== 'https:' || !(profileUrl.hostname === 'hh.ru' || profileUrl.hostname.endsWith('.hh.ru'))
      || profileUrl.pathname.replace(/\/$/, '') !== '/applicant/profile/me') throw new Error('Profile navigation changed')
    if (!await root.locator('[data-qa="compact-resume-title"]').isVisible()) throw new Error('Resume section disappeared')
    if (!cards.length && await root.locator('a[data-qa^="resume-card-link-"]').count() > 0) throw new Error('Resume card markup changed')
    if (cards.length > 100) throw new Error('Too many cards')
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
