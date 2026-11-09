import type { Locator } from 'playwright'

/** Explicitly intercepted target, not missing markup and not an uncertain dispatched click. */
export class ClickObstructedError extends Error {
  constructor() { super('HH_ELEMENT_OBSTRUCTED') }
}

/** Trial performs Playwright's actionability checks without dispatching a click. */
export async function ensureClickReady(target: Locator): Promise<boolean> {
  if (await target.count() !== 1 || !await target.isVisible() || !await target.isEnabled()) return false
  try {
    await target.click({ trial: true, timeout: 1500 })
    return true
  } catch {
    // Do not classify every timeout as an overlay. Confirm that another element receives pointer
    // events at the visible target's centre. DOM, text and Playwright error logs stay in the browser.
    const obstructed = await target.evaluate(element => {
      const box = element.getBoundingClientRect()
      const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right)
      const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom)
      if (right <= left || bottom <= top || getComputedStyle(element).visibility === 'hidden'
          || getComputedStyle(element).pointerEvents === 'none') return false
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      return hit !== null && hit !== element && !element.contains(hit)
    }).catch(() => false)
    if (obstructed) throw new ClickObstructedError()
    return false
  }
}
