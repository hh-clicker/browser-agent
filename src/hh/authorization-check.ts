import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'

export const HH_PROFILE_URL = 'https://hh.ru/applicant/profile/me'

export interface AuthorizationCheckResult {
  status: 'AUTHORIZED' | 'REQUIRED' | 'UNKNOWN'
  message: string
}

const PROFILE_ROOT = '.ResumeProfileFront-ReactRoot'
// Селекторы из реальной страницы профиля; отсутствие резюме не означает отсутствие входа.
const PROFILE_NAME = `${PROFILE_ROOT} [data-qa="applicant-profile-common-name"]`
const PROFILE_EDIT = `${PROFILE_ROOT} [data-qa="applicant-profile-common-edit-title"]`
const CHALLENGE = '[data-qa*="captcha" i], iframe[src*="captcha" i], .g-recaptcha, .smart-captcha'

function unknown(message: string): AuthorizationCheckResult {
  return { status: 'UNKNOWN', message }
}

export async function checkAuthorization(page: Page): Promise<AuthorizationCheckResult> {
  try {
    const response = await page.goto(HH_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    if (!response || response.status() >= 400) {
      return unknown('HH не загрузил страницу профиля. Проверьте открытую вкладку и повторите проверку.')
    }

    const deadline = Date.now() + 10_000
    while (!page.isClosed() && Date.now() < deadline) {
      const url = new URL(page.url())
      if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))) {
        return unknown('HH перенаправил на другую страницу. Завершите вход вручную и повторите проверку.')
      }

      const challengeVisible = await page.locator(CHALLENGE).filter({ visible: true }).count() > 0
      const challengeText = await page.getByText(/пройдите капчу|подтвердите,? что вы не робот|введите текст с картинки/i).first().isVisible()
      if (/captcha/i.test(url.pathname) || challengeVisible || challengeText) {
        return unknown('HH запросил проверку безопасности. Пройдите её вручную в открытой вкладке.')
      }

      if (/^\/(?:account\/login|auth\/applicant)(?:\/|$)/.test(url.pathname)) {
        return { status: 'REQUIRED', message: 'HH открыл страницу входа. Войдите вручную и нажмите «Проверить вход».' }
      }

      if (url.pathname.replace(/\/$/, '') === '/applicant/profile/me') {
        const [nameVisible, editVisible] = await Promise.all([
          page.locator(PROFILE_NAME).isVisible(),
          page.locator(PROFILE_EDIT).isVisible(),
        ])
        if (nameVisible && editVisible) {
          return { status: 'AUTHORIZED', message: 'Вход в профиль соискателя HH подтверждён.' }
        }
      }
      await delay(250)
    }
    return unknown('Не удалось распознать страницу профиля. Проверьте вкладку HH и повторите проверку.')
  } catch {
    // Не отправляем HTML, cookies, контакты или сырые сетевые ошибки в протокол команды.
    return unknown('Не удалось завершить проверку: страница недоступна, закрыта или не успела загрузиться.')
  }
}
