import type { BrowserContext, Page } from 'playwright'
import { CODE_ASSISTANT_SCRIPT, CODE_ASSESSMENT_BINDING } from './code-assistant-script.js'
import { generateCodeSolution, type CodeSolutionResult } from './code-solution.js'

export function isCodeAssessmentPage(page: Page): boolean {
  try {
    const url = new URL(page.url())
    return url.origin === 'https://assessment.hh.ru' && /^\/code\/\d+\/?$/.test(url.pathname)
  } catch { return false }
}

export async function installCodeAssistant(context: BrowserContext,
    generator: (input: unknown) => Promise<CodeSolutionResult> = generateCodeSolution): Promise<void> {
  const activePages = new WeakSet<Page>()
  await context.exposeBinding(CODE_ASSESSMENT_BINDING, async ({ page, frame }, input: unknown) => {
    if (frame !== page.mainFrame() || !isCodeAssessmentPage(page)) throw new Error('ASSESSMENT_ORIGIN_DENIED')
    const userActivated = await page.evaluate(() => navigator.userActivation?.isActive === true).catch(() => false)
    if (!userActivated) throw new Error('USER_GESTURE_REQUIRED')
    if (activePages.has(page)) throw new Error('CODE_SOLUTION_ALREADY_RUNNING')
    activePages.add(page)
    try {
      return await generator(input)
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'GENERATION_FAILED'
      throw new Error(code)
    } finally { activePages.delete(page) }
  })
  await context.addInitScript({ content: CODE_ASSISTANT_SCRIPT })
  await Promise.all(context.pages().filter(isCodeAssessmentPage).map(page => page.evaluate(CODE_ASSISTANT_SCRIPT).catch(() => undefined)))
}
