import { randomUUID } from 'node:crypto'

export interface GenerationStatusReport {
  checkId: string; requestId: string; ageMs: number
  state: 'READY' | 'AUTH_REQUIRED' | 'UNAVAILABLE' | 'CHECK_FAILED'
  model: string | null; reasoningEffort: string | null; cliVersion: string | null
  queued: number | null; running: number | null
  limits?: { primary: LimitWindow | null; secondary: LimitWindow | null; checkedAt?: string | null } | null
}
interface LimitWindow { usedPercent: number; windowDurationMins: number; resetsAt: number }
function limitWindow(value: unknown): LimitWindow | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.usedPercent !== 'number' || !Number.isFinite(v.usedPercent) || v.usedPercent < 0 || v.usedPercent > 100
      || count(v.windowDurationMins) === null || v.windowDurationMins === 0 || count(v.resetsAt) === null) return null
  return { usedPercent: v.usedPercent, windowDurationMins: v.windowDurationMins as number, resetsAt: v.resetsAt as number }
}
const shortString = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value) ? value : null
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Read-only: neither endpoint starts generation or logs in. */
export async function checkGenerationStatus(requestId: string, signal: AbortSignal,
    options: { baseUrl?: string; fetcher?: typeof fetch; refresh?: boolean } = {}): Promise<GenerationStatusReport> {
  const result: GenerationStatusReport = { checkId: randomUUID(), requestId, ageMs: 0, state: 'UNAVAILABLE',
    model: null, reasoningEffort: null, cliVersion: null, queued: null, running: null }
  const get = async (path: string, timeout: number) => {
    const base = options.baseUrl ?? process.env.HH_CLICKER_GENERATION_URL ?? 'http://127.0.0.1:17374'
    const response = await (options.fetcher ?? fetch)(new URL(path, base), {
      method: path.endsWith('/refresh') ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })
    if (!response.ok) throw new Error('STATUS_UNAVAILABLE')
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('INVALID_STATUS')
    return data as Record<string, unknown>
  }
  try {
    const health = await get('/health', 3000)
    result.model = shortString(health.model)
    result.reasoningEffort = shortString(health.reasoningEffort)
    result.cliVersion = shortString(health.cliVersion)
    result.queued = count(health.queued); result.running = count(health.running)
    if (health.ok !== true) return result
    if (!result.cliVersion) return { ...result, state: 'CHECK_FAILED' }
    result.state = 'CHECK_FAILED'
    const auth = await get(options.refresh ? '/auth/status/refresh' : '/auth/status', 12000)
    if (auth.authenticated === true && auth.limits && typeof auth.limits === 'object') {
      const limits = auth.limits as Record<string, unknown>
      result.limits = { primary: limitWindow(limits.primary), secondary: limitWindow(limits.secondary) }
      if (typeof auth.checkedAt === 'string' && Number.isFinite(Date.parse(auth.checkedAt))) result.limits.checkedAt = auth.checkedAt
    }
    if (auth.authenticated === true) result.state = 'READY'
    else if (auth.authenticated === false && auth.error && typeof auth.error === 'object'
        && 'code' in auth.error && auth.error.code === 'AUTH_REQUIRED') result.state = 'AUTH_REQUIRED'
    return result
  } catch { return result }
}

// Runs independently of both the HH command queue and heartbeat delivery.
export class GenerationStatusProbe {
  report: GenerationStatusReport | null = null
  #active = false
  #lastCheck = 0
  get snapshot(): GenerationStatusReport | null {
    return this.report ? { ...this.report, ageMs: Math.min(60001, Math.max(0, Date.now() - this.#lastCheck)) } : null
  }
  refresh(requestId: string, signal: AbortSignal): void {
    if (signal.aborted || this.#active || (this.report?.requestId === requestId && Date.now() - this.#lastCheck < 30000)) return
    this.#active = true
    // Heartbeats read only the local snapshot. A changed requestId comes from the user's refresh button.
    void checkGenerationStatus(requestId, signal, { refresh: this.report !== null && this.report.requestId !== requestId }).then(report => {
      if (!signal.aborted) { this.report = report; this.#lastCheck = Date.now() }
    }).finally(() => { this.#active = false })
  }
}
