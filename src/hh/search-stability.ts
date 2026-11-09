import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import type { SelectorRegistry } from './selector-registry.js'

/** In-memory comparison only; card contents never enter reports or logs. */
export async function searchFingerprint(page: Page, registry: SelectorRegistry): Promise<{ count: number; value: string }> {
  const cards = await page.locator(registry.locator('search', 'cards')).evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent, links: [...node.querySelectorAll('a[href]')].map(link => link.getAttribute('href')),
  })))
  const pager = await page.locator(registry.locator('search', 'pager')).evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent, links: [...node.querySelectorAll('a[href]')].map(link => link.getAttribute('href')),
  })))
  return { count: cards.length, value: JSON.stringify([cards, pager]) }
}

export async function waitForStableSearch(page: Page, registry: SelectorRegistry,
    options: { timeoutMs?: number; intervalMs?: number; stableSamples?: number } = {}): Promise<'STABLE' | 'EMPTY' | 'MISSING' | 'UNSTABLE'> {
  const deadline = Date.now() + (options.timeoutMs ?? 12_000)
  let previous = '', stable = 0, sawCards = false
  while (Date.now() < deadline) {
    const snapshot = await searchFingerprint(page, registry)
    sawCards ||= snapshot.count > 0
    stable = snapshot.count > 0 && snapshot.value === previous ? stable + 1 : 0
    previous = snapshot.value
    if (stable >= (options.stableSamples ?? 5)) return 'STABLE'
    if (!snapshot.count && await page.getByText(/по вашему запросу (?:ничего не найдено|не найдено вакансий)|вакансии не найдены/i).first().isVisible()) return 'EMPTY'
    await delay(options.intervalMs ?? 500)
  }
  return sawCards ? 'UNSTABLE' : 'MISSING'
}
