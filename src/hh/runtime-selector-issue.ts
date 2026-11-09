import type { Page } from 'playwright'
import { diagnoseSelectors, type SelectorDiagnosticReport } from './selector-diagnostics.js'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'

/** A runtime failure is only a selector issue when a loaded HH page fails its structural contract. */
export async function runtimeSelectorIssue(page: Page, registry?: SelectorRegistry): Promise<SelectorDiagnosticReport | null> {
  const skipped = (reason: string) => { console.info(`[selector-runtime] skipped=${reason}`); return null }
  if (page.isClosed()) return skipped('TAB_CLOSED')
  try {
    const loaded = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      return { ready: document.readyState !== 'loading', hasText: Boolean(document.body?.innerText.trim()),
        httpError: Boolean(navigation?.responseStatus && navigation.responseStatus >= 400) }
    })
    // Operational readers use DOMContentLoaded. Images and analytics may keep the load event
    // pending even after the reader has established a structural failure.
    if (!loaded.ready || !loaded.hasText || loaded.httpError)
      return skipped(loaded.httpError ? 'HTTP_ERROR' : !loaded.ready ? 'DOM_LOADING' : 'EMPTY_DOCUMENT')
    const obstructed = await page.locator('[role="dialog"], dialog[open]').filter({ visible: true }).evaluateAll(dialogs =>
      dialogs.some(dialog => !dialog.querySelector('form[name="vacancy_response"], form[action*="/vacancy_response/edit_ajax"]')))
    if (obstructed) return skipped('OBSTRUCTING_DIALOG')
    const report = await diagnoseSelectors(page, undefined, registry ?? loadHhSelectors())
    const failures = report.rows.filter(row => row.status === 'FAIL').length
    console.info(`[selector-runtime] page=${report.pageType} status=${report.status} failures=${failures}`)
    return report.status === 'CHECKED' && failures ? report : null
  } catch { return skipped('CHECK_UNAVAILABLE') }
}
