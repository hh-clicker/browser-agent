import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'

export const HH_PROFILE_URL = 'https://hh.ru/applicant/profile/me'

export interface AuthorizationCheckResult {
  status: 'AUTHORIZED' | 'REQUIRED' | 'UNKNOWN'
  message: string
}


function unknown(message: string): AuthorizationCheckResult {
  return { status: 'UNKNOWN', message }
}

function loginRedirect(url: URL): AuthorizationCheckResult | null {
  if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
      || !/^\/(?:account\/login|auth\/applicant)(?:\/|$)/.test(url.pathname)) return null
  return { status: 'REQUIRED', message: 'HH открыл страницу входа. Войдите вручную и нажмите «Проверить вход».' }
}

export async function checkAuthorization(page: Page, registry: SelectorRegistry = loadHhSelectors()): Promise<AuthorizationCheckResult> {
  try {
    const response = await page.goto(HH_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    if (!response || response.status() >= 400) {
      return unknown('HH не загрузил страницу профиля. Проверьте открытую вкладку и повторите проверку.')
    }
    // A known login redirect needs no DOM reads, selectors or polling budget.
    const initialLogin = loginRedirect(new URL(page.url()))
    if (initialLogin) return initialLogin

    const deadline = Date.now() + 10_000
    while (!page.isClosed() && Date.now() < deadline) {
      const url = new URL(page.url())
      if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))) {
        return unknown('HH перенаправил на другую страницу. Завершите вход вручную и повторите проверку.')
      }

      const login = loginRedirect(url)
      if (login) return login

      const challengeVisible = await page.locator(registry.locator('common', 'challenge')).filter({ visible: true }).count() > 0
      const challengeText = await page.getByText(/пройдите капчу|подтвердите,? что вы не робот|введите текст с картинки/i).first().isVisible()
      if (/captcha/i.test(url.pathname) || challengeVisible || challengeText) {
        return unknown('HH запросил проверку безопасности. Пройдите её вручную в открытой вкладке.')
      }

      if (url.pathname.replace(/\/$/, '') === '/applicant/profile/me') {
        // HH redirects logged-out visitors to account/login. Profile controls are not an auth
        // contract: their markup can change independently, and resume discovery checks its own DOM.
        return { status: 'AUTHORIZED', message: 'Вход в профиль соискателя HH подтверждён.' }
      }
      await delay(250)
    }
    return unknown('HH не открыл страницу профиля. Проверьте вкладку HH и повторите проверку.')
  } catch {
    // Не отправляем HTML, cookies, контакты или сырые сетевые ошибки в протокол команды.
    return unknown('Не удалось завершить проверку: страница недоступна, закрыта или не успела загрузиться.')
  }
}
