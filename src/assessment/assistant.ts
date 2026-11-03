import type { BrowserContext, Page } from 'playwright'
import { answerAssessmentQuestion, type AssessmentQuestionAnswer } from './question.js'
import { ASSESSMENT_ASSISTANT_SCRIPT, ASSESSMENT_BINDING } from './assistant-script.js'

export function isAssessmentPage(page: Page): boolean {
  try {
    const url = new URL(page.url())
    return url.origin === 'https://assessment.hh.ru' && url.pathname.startsWith('/tests/')
  } catch { return false }
}

export async function installAssessmentAssistant(context: BrowserContext,
    answerer: (input: unknown) => Promise<AssessmentQuestionAnswer> = answerAssessmentQuestion): Promise<void> {
  const activePages = new WeakSet<Page>()
  await context.exposeBinding(ASSESSMENT_BINDING, async ({ page, frame }, input: unknown) => {
    if (frame !== page.mainFrame() || !isAssessmentPage(page)) throw new Error('ASSESSMENT_ORIGIN_DENIED')
    const userActivated = await page.evaluate(() => navigator.userActivation?.isActive === true).catch(() => false)
    if (!userActivated) throw new Error('USER_GESTURE_REQUIRED')
    if (activePages.has(page)) throw new Error('QUESTION_ALREADY_RUNNING')
    activePages.add(page)
    try {
      return await answerer(input)
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'GENERATION_FAILED'
      throw new Error(code)
    } finally { activePages.delete(page) }
  })
  await context.addInitScript({ content: ASSESSMENT_ASSISTANT_SCRIPT })
  await Promise.all(context.pages().filter(isAssessmentPage).map(page => page.evaluate(ASSESSMENT_ASSISTANT_SCRIPT).catch(() => undefined)))
}
