import type { Page } from 'playwright'

export async function vacancyAccessRestriction(page: Page): Promise<string | null> {
  if (await page.getByText(/Вам недоступна эта вакансия|у вас нет доступа к этой вакансии|доступ к вакансии ограничен/i).filter({ visible: true }).count())
    return 'HH ограничил доступ к вакансии. Это не поломка селекторов.'
  if (await page.getByText(/вакансия не найдена|вакансия удалена|страница не найдена/i).filter({ visible: true }).count())
    return 'HH сообщил, что страница недоступна. Это не поломка селекторов.'
  return null
}

export async function selectorRepairBlocker(page: Page): Promise<string | null> {
  if (page.isClosed()) return 'Вкладка закрыта.'
  const url = new URL(page.url())
  if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
      || url.hostname === 'assessment.hh.ru' || url.hostname.endsWith('.assessment.hh.ru')) return 'Эта страница не поддерживает исправление селекторов.'
  if (/^\/(?:account\/login|auth\/applicant)(?:\/|$)/.test(url.pathname)) return 'Сначала войдите в HH.'
  if (/captcha/i.test(url.pathname) || await page.locator('[data-qa*="captcha" i], iframe[src*="captcha" i], .g-recaptcha, .smart-captcha').filter({ visible: true }).count()
      || await page.getByText(/пройдите капчу|подтвердите,? что вы не робот|введите текст с картинки/i).first().isVisible()) return 'Сначала пройдите проверку безопасности HH.'
  const restriction = await vacancyAccessRestriction(page)
  if (restriction) return restriction
  if (await page.locator('[role="dialog"], dialog[open]').filter({ visible: true }).count())
    return 'Страница перекрыта диалогом HH. Сначала разберите его и повторите проверку.'
  return null
}

/** Preserve useful HTML; remove executable noise and technical secrets in the renderer. */
export async function selectorRepairHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = []
    const stack: { node: Node; close?: string }[] = [{ node: document.documentElement }]
    while (stack.length) {
      const entry = stack.pop()!
      if (entry.close) { parts.push(entry.close); continue }
      if (entry.node.nodeType === Node.TEXT_NODE) {
        const text = entry.node.textContent ?? ''
        if (text.trim()) {
          const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          parts.push(escaped)
        }
        continue
      }
      if (!(entry.node instanceof HTMLElement)) continue
      const node = entry.node
      if (node.matches('script,style,noscript,iframe,svg,img,picture,canvas,video,audio,object,embed,link,meta')) continue
      const tag = node.tagName.toLowerCase()
      const sensitiveControl = node.matches('input,textarea,select')
        && /token|secret|password|csrf|xsrf|authorization|credential|signature|api[-_]?key|session/i.test(node.getAttribute('name') ?? '')
      const attributes: string[] = []
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase()
        let value = attribute.value
        if (/^(?:on|style$|src|nonce$|integrity$)/.test(name)
            || /token|secret|password|csrf|xsrf|authorization|credential|signature|api[-_]?key|session/i.test(name)) continue
        if (!/^(?:class|id|role|name|type|href|for|form|title|lang|tabindex|hidden|disabled|readonly|multiple|open|selected|checked|value|data-[\w-]+|aria-[\w-]+)$/.test(name)) continue
        if (name === 'href') {
          try {
            const url = new URL(value, location.href)
            if (!['http:', 'https:'].includes(url.protocol)) continue
            if (url.username || url.password) value = '[REDACTED]'
            else value = value.replace(/([?&#])([^=&#]+)=([^&#]*)/g, (pair, prefix: string, rawKey: string, rawValue: string) => {
              try {
                const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
                const decoded = decodeURIComponent(rawValue.replace(/\+/g, ' '))
                return /token|secret|password|csrf|xsrf|authorization|credential|signature|api[-_]?key|session|^code$|^sid$/i.test(key)
                  || /[?&#](?:[^=&#]*(?:token|secret|password|csrf|xsrf|signature)|code)=/i.test(decoded)
                  ? `${prefix}${rawKey}=[REDACTED]` : pair
              } catch { return `${prefix}${rawKey}=[REDACTED]` }
            })
          } catch { continue }
        }
        if (name === 'value' && (sensitiveControl || node.matches('input[type="password"], input[type="hidden"]'))) value = '[REDACTED]'
        attributes.push(`${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`)
      }
      const opening = `<${tag}${attributes.length ? ' ' + attributes.join(' ') : ''}>`
      parts.push(opening)
      if (!node.matches('area,base,br,col,hr,input,param,source,track,wbr')) stack.push({ node, close: `</${tag}>` })
      if (!sensitiveControl && !node.matches('input')) {
        const children = node instanceof HTMLTemplateElement ? node.content.childNodes : node.childNodes
        for (const child of [...children].reverse()) stack.push({ node: child })
      }
    }
    return parts.join('')
  })
}
