import { setTimeout as delay } from 'node:timers/promises'

export interface CodeSolutionInput {
  title: string
  statement: string
  language: string
  code: string
  taskNumber: number | null
  taskCount: number | null
}

export interface CodeSolutionResult {
  code: string
  explanation: string
  warnings: string[]
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

function validCounter(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10_000)
}

function validateInput(value: unknown): CodeSolutionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CODE_TASK')
  const input = value as Partial<CodeSolutionInput>
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1_000
      || typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 50_000
      || typeof input.language !== 'string' || !input.language.trim() || input.language.length > 100
      || typeof input.code !== 'string' || input.code.length > 100_000
      || !validCounter(input.taskNumber) || !validCounter(input.taskCount)
      || (input.taskNumber !== null && input.taskCount !== null && input.taskNumber > input.taskCount)) {
    throw new Error('INVALID_CODE_TASK')
  }
  return {
    title: input.title.trim(), statement: input.statement.trim(), language: input.language.trim(),
    code: input.code.replace(/\r\n?/g, '\n'), taskNumber: input.taskNumber, taskCount: input.taskCount,
  }
}

function parseResult(value: unknown): CodeSolutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE')
  const result = value as Partial<CodeSolutionResult>
  if (typeof result.code !== 'string' || !result.code.trim() || result.code.length > 100_000 || result.code.includes('\0')
      || typeof result.explanation !== 'string' || result.explanation.length > 4_000 || result.explanation.includes('\0')
      || !Array.isArray(result.warnings) || result.warnings.length > 10
      || result.warnings.some(warning => typeof warning !== 'string' || warning.length > 1_000 || warning.includes('\0'))) {
    throw new Error('INVALID_RESPONSE')
  }
  return { code: result.code.replace(/\r\n?/g, '\n').trim(), explanation: result.explanation.trim(), warnings: result.warnings }
}

export async function generateCodeSolution(value: unknown,
    options: { baseUrl?: string; timeoutMs?: number; pollMs?: number; fetcher?: typeof fetch } = {}): Promise<CodeSolutionResult> {
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
  let job = await request('/code-solutions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  if (typeof job.id !== 'string' || !UUID.test(job.id)) throw new Error('INVALID_RESPONSE')
  const id = job.id
  while (true) {
    if (job.id !== id) throw new Error('INVALID_RESPONSE')
    if (job.status === 'done') return parseResult(job.result)
    if (job.status === 'failed') {
      const code = (job.error as { code?: unknown } | undefined)?.code
      throw new Error(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'GENERATION_FAILED')
    }
    if (!['queued', 'running'].includes(String(job.status))) throw new Error('INVALID_RESPONSE')
    if (Date.now() >= deadline) throw new Error('TIMEOUT')
    await delay(options.pollMs ?? 1_000)
    if (Date.now() >= deadline) throw new Error('TIMEOUT')
    job = await request(`/code-solutions/${id}`)
  }
}
