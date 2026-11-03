import { setTimeout as delay } from 'node:timers/promises'

export interface AiLetterSettings { enabled: boolean; template: string; maxLength: number }
export interface PreparedLetter { text: string; source: 'STATIC' | 'GENERATED' | 'FALLBACK' | 'RATE_LIMIT' | 'AI_FAILED'; errorCode: string | null; generationId: string | null; resetsAt?: number | null }
export interface LetterTask { itemId: string; coverLetter: string; aiLetter?: AiLetterSettings; resumePlainText?: string | null; aiFallbackConfirmed?: boolean; generationAttempt?: number }
const MARKER = '#AI_CHANGE#'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function assembleLetter(settings: AiLetterSettings, middle: unknown): string {
  const marker = settings.template.indexOf(MARKER)
  if (marker < 0 || marker !== settings.template.lastIndexOf(MARKER) || typeof middle !== 'string'
      || !middle.trim() || middle.includes(MARKER) || middle.includes('\0')) throw new Error('INVALID_OUTPUT')
  const text = settings.template.slice(0, marker) + middle.trim() + settings.template.slice(marker + MARKER.length)
  if (text.length > settings.maxLength) throw new Error('INVALID_OUTPUT')
  return text
}

// Each task gets at most one POST. Polling never re-submits generation or an HH application.
export async function prepareCoverLetter(task: LetterTask, vacancyText: string | null, allowed: () => Promise<boolean>,
    options: { baseUrl?: string; timeoutMs?: number; pollMs?: number; fetcher?: typeof fetch } = {}): Promise<PreparedLetter | null> {
  const fallback = (errorCode: string, generationId: string | null = null): PreparedLetter => task.coverLetter.trim()
    ? { text: task.coverLetter, source: 'FALLBACK', errorCode, generationId }
    : { text: '', source: 'AI_FAILED', errorCode, generationId }
  if (task.coverLetter.includes(MARKER) || task.coverLetter.length > 10000 || task.coverLetter.includes('\0')) throw new Error('INVALID_FALLBACK')
  if (!await allowed()) return null
  const settings = task.aiLetter
  if (!settings?.enabled) return { text: task.coverLetter, source: 'STATIC', errorCode: null, generationId: null }
  if (task.aiFallbackConfirmed) return fallback('RATE_LIMIT_CONFIRMED')
  if (!task.resumePlainText?.trim()) return fallback('RESUME_TEXT_MISSING')
  if (!vacancyText?.trim()) return fallback('VACANCY_TEXT_MISSING')
  const budget = settings.maxLength - settings.template.length + MARKER.length
  if (!Number.isInteger(settings.maxLength) || settings.maxLength > 5000 || budget < 200
      || settings.template.split(MARKER).length !== 2) return fallback('INVALID_TEMPLATE')
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 210_000
  const deadline = Date.now() + timeoutMs
  let generationId: string | null = null
  let base: URL
  try {
    base = new URL(options.baseUrl ?? process.env.HH_CLICKER_GENERATION_URL ?? 'http://127.0.0.1:17374')
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return fallback('SERVICE_UNAVAILABLE')
  } catch { return fallback('SERVICE_UNAVAILABLE') }
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(new URL(path, base), { ...init, redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) })
    if (!response.ok) throw new Error('SERVICE_UNAVAILABLE')
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE')
    return value as { id?: unknown; status?: unknown; result?: { letter?: unknown }; error?: { code?: unknown; resetsAt?: unknown } }
  }
  let job: Awaited<ReturnType<typeof request>>
  try {
    const attempt = task.generationAttempt ?? 0
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('INVALID_ATTEMPT')
    job = await request('/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `application-${task.itemId}${attempt ? `-${attempt}` : ''}` },
      body: JSON.stringify({ resumeText: task.resumePlainText, vacancyText, maxLength: budget,
        instructions: 'Верни только середину письма: 1–2 коротких абзаца без приветствия, заключительной фразы, подписи и #AI_CHANGE#. Шапку и подвал приложение добавит отдельно.' }) })
    if (typeof job.id !== 'string' || !UUID.test(job.id)) return fallback('INVALID_RESPONSE')
    generationId = job.id
  } catch { return fallback('SERVICE_UNAVAILABLE') }
  while (true) {
    // Failure to check run state is not permission to use fallback and send an application.
    if (!await allowed()) return null
    if (job.id !== generationId) return fallback('INVALID_RESPONSE', generationId)
    if (job.status === 'done') {
      try { return { text: assembleLetter(settings, job.result?.letter), source: 'GENERATED', errorCode: null, generationId } }
      catch { return fallback('INVALID_OUTPUT', generationId) }
    }
    if (job.status === 'failed') {
      const code = job.error?.code
      if (code === 'RATE_LIMIT') {
        const resetsAt = job.error?.resetsAt
        return { text: '', source: 'RATE_LIMIT', errorCode: 'RATE_LIMIT', generationId,
          resetsAt: typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt) && resetsAt >= 0 && resetsAt <= 253402300799 ? resetsAt : null }
      }
      return fallback(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'GENERATION_FAILED', generationId)
    }
    if (!['queued', 'running'].includes(String(job.status))) return fallback('INVALID_RESPONSE', generationId)
    if (Date.now() >= deadline) return fallback('TIMEOUT', generationId)
    await delay(options.pollMs ?? 1000)
    if (!await allowed()) return null
    try { job = await request(`/generations/${generationId}`) }
    catch { return fallback(Date.now() >= deadline ? 'TIMEOUT' : 'SERVICE_UNAVAILABLE', generationId) }
  }
}
