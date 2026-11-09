import type { Page } from 'playwright'
import { isVacancyDetailUrl } from './application-evidence.js'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'

/** null = not read; empty string = recognized description without textual content. */
export async function extractVacancyText(page: Page, hhVacancyId: string, registry?: SelectorRegistry): Promise<string | null> {
  try {
    if (!/^\d+$/.test(hhVacancyId)) return null
    const expectedUrl = page.url()
    if (!isVacancyDetailUrl(expectedUrl, `https://hh.ru/vacancy/${hhVacancyId}`)) return null
    const selectors = registry ?? loadHhSelectors()
    return await page.locator(selectors.locator('vacancy', 'description')).evaluateAll((candidates, { expectedUrl }) => {
      if (location.href !== expectedUrl) return null
      // Both ordinary and branded HH layouts mark the employer's description this way.
      // Do not include the surrounding brand template, skills or recommendations.
      // Despite its name, .vacancy-description-print also wraps the visible branded layout.
      const sections = candidates
        .filter(node => !node.closest('[data-qa="vacancy-serp__vacancy"], [data-qa="vacancy-view-vacancies-from-search"], [hidden], [aria-hidden="true"]')
          && getComputedStyle(node).visibility !== 'hidden'
          && getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0)
      if (sections.length !== 1) return null
      const parts: string[] = []
      const stack: (Node | string)[] = [sections[0]!]
      const blockTags = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE'])
      // Self-contained iterative traversal avoids tsx/esbuild's Node-only __name helper.
      while (stack.length) {
        const node = stack.pop()!
        if (typeof node === 'string') { parts.push(node); continue }
        if (node.nodeType === Node.TEXT_NODE) {
          const raw = node.textContent ?? ''
          const whiteSpace = node.parentElement ? getComputedStyle(node.parentElement).whiteSpace : 'normal'
          parts.push(/pre|break-spaces/.test(whiteSpace) ? raw.replace(/\r\n?/g, '\n') : raw.replace(/[\t\r\n ]+/g, ' '))
          continue
        }
        if (!(node instanceof HTMLElement)) continue
        if (node.matches('script,style,template,noscript,svg,img,picture,canvas,iframe,video,audio,object,embed,button,input,textarea,select,[role="button"],[hidden],[aria-hidden="true"]')) continue
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        if (node.tagName === 'BR') { parts.push('\n'); continue }
        if (blockTags.has(node.tagName)) {
          parts.push(node.tagName === 'LI' ? '\n- ' : '\n')
          stack.push('\n')
        } else if (node.tagName === 'TD' || node.tagName === 'TH') {
          stack.push(' ')
        }
        stack.push(...[...node.childNodes].reverse())
      }
      const text = parts.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
        .split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
      // An optional snapshot must never break the application result transport.
      return text.length <= 100000 ? text : null
    }, { expectedUrl })
  } catch {
    // Navigation, an unavailable block or extraction failure does not stop an application.
    return null
  }
}
