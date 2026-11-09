import { setTimeout as delay } from 'node:timers/promises'
import type { SelectorGroup } from '../hh/selector-registry.js'

export interface SelectorRepairDiagnostic {
  key: string
  status: 'PASS' | 'FAIL' | 'NOT_CHECKED' | 'NOT_APPLICABLE' | 'STATE_NOT_CHECKED'
  matched: number
  visible: number
  required: boolean
  message: string
}
export interface SelectorRepairAudit { status: 'verified' | 'absent' | 'unresolved'; include: string; exclude: string; reason: string }
export interface SelectorRepairResult {
  selectors: Record<string, { kind: 'css' | 'xpath'; value: string }>
  audit: Record<string, SelectorRepairAudit>
}
export interface SelectorRepairObservations { fields: Array<{ key: string; [field: string]: unknown }> }
export interface SelectorRepairInput {
  group: SelectorGroup; brokenKeys: string[]; diagnostics: SelectorRepairDiagnostic[]; html: string
  review?: { candidate: SelectorRepairResult; observations: SelectorRepairObservations }
}
export async function generateSelectorRepair(input: SelectorRepairInput, requestId: string,
    options: { baseUrl?: string; fetcher?: typeof fetch; pollMs?: number; timeoutMs?: number } = {}): Promise<unknown> {
  const base = new URL(options.baseUrl ?? process.env.HH_CLICKER_GENERATION_URL ?? 'http://127.0.0.1:17374')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Некорректный адрес Generation Agent.')
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + (options.timeoutMs ?? 210_000)
  const read = async (path: string, init: RequestInit = {}) => {
    try {
      const response = await fetcher(new URL(path, base), { ...init, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) })
      if (!response.ok) throw new Error('HTTP_ERROR')
      return await response.json() as { id?: unknown; status?: unknown; result?: unknown; error?: { code?: unknown } }
    } catch { throw new Error('Не удалось связаться с Generation Agent. Автоматического повтора запроса не будет.') }
  }
  // Only this POST can create a job; all following requests are reads of that job.
  let job = await read('/selector-repair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `selector-repair-${requestId}` },
    body: JSON.stringify(input) })
  const id = job?.id
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Generation Agent вернул некорректный ответ.')
  for (;;) {
    if (job?.id !== id) throw new Error('Generation Agent вернул ответ другого задания.')
    if (job.status === 'done') return job.result
    if (job.status === 'failed') {
      const messages: Record<string, string> = {
        AUTH_REQUIRED: 'Войдите в Codex и повторите исправление.', RATE_LIMIT: 'Лимит Codex исчерпан. Повторите исправление позже.',
        TIMEOUT: 'Истекло время ожидания ИИ. Исправление не сохранено.', INVALID_OUTPUT: 'ИИ вернул некорректные селекторы. Исправление не сохранено.',
        NETWORK_ERROR: 'Codex не смог подключиться к сервису. Исправление не сохранено.',
        INPUT_TOO_LARGE: 'Codex отклонил слишком большое сообщение. Обновите Generation Agent: полный HTML должен читаться из отдельного файла.',
        MODEL_UNAVAILABLE: 'Модель починки селекторов недоступна. Для этой операции используется отдельная модель Sol / medium.',
      }
      throw new Error(messages[String(job.error?.code)] ?? 'ИИ не смог подготовить исправление. Локальные селекторы не изменены.')
    }
    if (!['queued', 'running'].includes(String(job.status))) throw new Error('Generation Agent вернул неизвестное состояние задания.')
    if (Date.now() >= deadline) throw new Error('Истекло время ожидания ИИ. Исправление не сохранено.')
    await delay(options.pollMs ?? 1000)
    job = await read(`/selector-repair/${id}`)
  }
}
