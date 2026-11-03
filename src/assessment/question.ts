import { setTimeout as delay } from 'node:timers/promises'

export interface AssessmentQuestionInput {
  question: string
  answers: string[]
  title: string
  taskNumber: number | null
  taskCount: number | null
}

export interface AssessmentQuestionAnswer {
  answerNumber: number
  answer: string
  explanation: string
  confidence: 'high' | 'medium' | 'low'
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

function validateInput(value: unknown): AssessmentQuestionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_QUESTION')
  const input = value as Partial<AssessmentQuestionInput>
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 20_000
      || !Array.isArray(input.answers) || input.answers.length < 2 || input.answers.length > 20
      || input.answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 10_000)
      || typeof input.title !== 'string' || input.title.length > 1_000
      || !validCounter(input.taskNumber) || !validCounter(input.taskCount)
      || (input.taskNumber !== null && input.taskCount !== null && input.taskNumber > input.taskCount)) {
    throw new Error('INVALID_QUESTION')
  }
  return {
    question: input.question.trim(), answers: input.answers.map(answer => answer.trim()), title: input.title.trim(),
    taskNumber: input.taskNumber, taskCount: input.taskCount,
  }
}

function validCounter(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10_000)
}

function parseAnswer(value: unknown, input: AssessmentQuestionInput): AssessmentQuestionAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE')
  const result = value as Partial<AssessmentQuestionAnswer>
  if (!Number.isInteger(result.answerNumber) || Number(result.answerNumber) < 1 || Number(result.answerNumber) > input.answers.length
      || typeof result.answer !== 'string' || result.answer !== input.answers[Number(result.answerNumber) - 1]
      || typeof result.explanation !== 'string' || result.explanation.length > 4_000
      || !['high', 'medium', 'low'].includes(String(result.confidence))) throw new Error('INVALID_RESPONSE')
  return result as AssessmentQuestionAnswer
}

export async function answerAssessmentQuestion(value: unknown,
    options: { baseUrl?: string; timeoutMs?: number; pollMs?: number; fetcher?: typeof fetch } = {}): Promise<AssessmentQuestionAnswer> {
  const input = validateInput(value)
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + (options.timeoutMs ?? 210_000)
  let base: URL
  try {
    base = new URL(options.baseUrl ?? process.env.HH_CLICKER_GENERATION_URL ?? 'http://127.0.0.1:17374')
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_URL')
  } catch { throw new Error('SERVICE_UNAVAILABLE') }
  const request = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    let response: Response
    try {
      response = await fetcher(new URL(path, base), { ...init, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))) })
    } catch { throw new Error('SERVICE_UNAVAILABLE') }
    if (!response.ok) throw new Error('SERVICE_UNAVAILABLE')
    const body: unknown = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_RESPONSE')
    return body as Record<string, unknown>
  }
  let job = await request('/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  if (typeof job.id !== 'string' || !UUID.test(job.id)) throw new Error('INVALID_RESPONSE')
  const id = job.id
  while (true) {
    if (job.id !== id) throw new Error('INVALID_RESPONSE')
    if (job.status === 'done') return parseAnswer(job.result, input)
    if (job.status === 'failed') {
      const code = (job.error as { code?: unknown } | undefined)?.code
      throw new Error(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'GENERATION_FAILED')
    }
    if (!['queued', 'running'].includes(String(job.status))) throw new Error('INVALID_RESPONSE')
    if (Date.now() >= deadline) throw new Error('TIMEOUT')
    await delay(options.pollMs ?? 1_000)
    if (Date.now() >= deadline) throw new Error('TIMEOUT')
    job = await request(`/questions/${id}`)
  }
}
