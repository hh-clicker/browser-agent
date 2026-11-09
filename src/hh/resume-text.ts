import type { Page } from 'playwright'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'

export async function extractResumeText(page: Page, hash: string, registry: SelectorRegistry = loadHhSelectors()): Promise<string> {
  const url = new URL(page.url())
  if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
    || url.pathname !== `/resume/${hash}` || url.searchParams.get('print') !== 'true') throw new Error('Resume URL changed')
  const root = page.locator(registry.locator('resumeText', 'root'))
  await root.first().waitFor({ state: 'visible', timeout: 8000 })
  if (await root.count() !== 1) throw new Error('RESUME_ROOT_AMBIGUOUS')
  await root.locator(registry.locator('resumeText', 'ready')).first().waitFor({ state: 'visible', timeout: 8000 })
  return root.locator(registry.locator('resumeText', 'blocks')).evaluateAll((candidates, expectedUrl) => {
    if (location.href !== expectedUrl) throw new Error('Resume navigation changed')
    const nodes = candidates.filter(node => node.getClientRects().length > 0)
    const blockTags = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'SECTION', 'TR', 'TABLE'])
    // Keep this callback self-contained: tsx/esbuild keepNames adds a Node-side
    // __name helper to nested named functions, which is unavailable inside page.evaluate.
    const text = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
      .map(section => {
        const parts: string[] = []
        const stack: (Node | string)[] = [section]
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
          if (node.matches('script,style,template,noscript,svg,img,picture,canvas,iframe,button,input,textarea,select,[role="button"],[hidden],[aria-hidden="true"],[data-qa="resume-block-contacts"],[data-qa="resume-photo"]')) continue
          const style = getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          if (node.tagName === 'BR') { parts.push('\n'); continue }
          if (blockTags.has(node.tagName)) {
            parts.push(node.tagName === 'LI' ? '\n- ' : '\n')
            stack.push('\n')
          }
          stack.push(...[...node.childNodes].reverse())
        }
        return parts.join('')
      }).join('\n\n').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
      .split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) throw new Error('RESUME_TEXT_EMPTY')
    if (text.length > 100000) throw new Error('RESUME_TEXT_TOO_LONG')
    return text
  }, url.href)
}

export async function readResumePrintText(createPage: () => Promise<Page>, hash: string, registry: SelectorRegistry = loadHhSelectors(),
    preserveFailure?: (page: Page) => Promise<boolean>): Promise<string> {
  if (!/^[a-f0-9]{20,100}$/.test(hash)) throw new Error('Некорректный идентификатор резюме.')
  const page = await createPage()
  let stage = 'открытие печатной страницы'
  let preserve = false
  try {
    await page.route('**/*', route => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.fallback())
    await page.addInitScript(() => { window.print = () => {} })
    const response = await page.goto(`https://hh.ru/resume/${hash}?print=true`, { waitUntil: 'domcontentloaded', timeout: 18000 })
    if (!response?.ok()) throw new Error('Print page unavailable')
    stage = 'распознавание страницы и извлечение текста'
    return await extractResumeText(page, hash, registry)
  } catch (cause) {
    preserve = await preserveFailure?.(page).catch(() => false) ?? false
    // Never expose HTML, contacts or Playwright's call log in the command error.
    const message = cause instanceof Error ? cause.message : ''
    const reason = message.includes('RESUME_TEXT_EMPTY') ? 'Распознанные блоки резюме не содержат текста.'
      : message.includes('RESUME_TEXT_TOO_LONG') ? 'Текст резюме превышает технический предел 100 000 символов.'
        : 'Проверьте вход, доступность резюме на HH и повторите добавление.'
    throw new Error(`Не удалось прочитать текст резюме. Этап: ${stage}. ${reason}`)
  } finally {
    if (!preserve) await page.close().catch(() => {})
  }
}
