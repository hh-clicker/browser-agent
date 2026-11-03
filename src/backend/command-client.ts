import { setTimeout as delay } from 'node:timers/promises'
import type { PreparedLetter } from '../generation/cover-letter.js'

import type { AgentRuntimeStatus } from '../agent/agent-runtime-status.js'
import type { BackendConfig } from '../config/backend-config.js'
import type { BrowserAgentCommand, BrowserAgentCommandResult, BrowserCommandExecutionResult } from './browser-agent-command.js'
import type { SearchScanProgress } from '../hh/vacancy-search.js'

type CommandExecutor = (command: BrowserAgentCommand) => Promise<BrowserCommandExecutionResult | void>
type StatusConsumer = (status: AgentRuntimeStatus) => void
type ResultDelivery = 'DELIVERED' | 'RETRY' | 'DISCARD'

export class CommandClient {
  readonly #config: BackendConfig
  readonly #stopController = new AbortController()
  #running: Promise<void> | null = null
  #pendingResult: BrowserAgentCommandResult | null = null

  constructor(config: BackendConfig) {
    this.#config = config
  }

  start(executor: CommandExecutor, statusConsumer: StatusConsumer): void {
    if (this.#running) {
      return
    }

    this.#running = this.#run(executor, statusConsumer)
  }

  async stop(): Promise<void> {
    this.#stopController.abort()

    if (this.#running) {
      await this.#running
      this.#running = null
    }
  }

  async applicationControl(commandId: string, permit = false): Promise<boolean> {
    const url = new URL(`/api/v1/browser-agent/commands/${encodeURIComponent(commandId)}/${permit ? 'application-submit' : 'application-control'}`, this.#config.baseUrl)
    url.searchParams.set('agentId', this.#config.agentId)
    // Unlike result delivery, this request must never be retried automatically.
    const response = await fetch(url, { method: permit ? 'POST' : 'GET', signal: this.#requestSignal() })
    if (!response.ok) throw new Error('Управление запуском недоступно')
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && 'allowed' in body && body.allowed === true
  }
  async prepareApplicationLetter(commandId: string, letter: PreparedLetter): Promise<boolean> {
    const url = new URL(`/api/v1/browser-agent/commands/${encodeURIComponent(commandId)}/application-letter`, this.#config.baseUrl)
    url.searchParams.set('agentId', this.#config.agentId)
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(letter), signal: this.#requestSignal() })
    if (!response.ok) throw new Error('Не удалось сохранить подготовленное письмо')
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && 'allowed' in body && body.allowed === true
  }

  async reportSearchProgress(commandId: string, progress: SearchScanProgress): Promise<void> {
    try {
      const response = await fetch(new URL(`/api/v1/browser-agent/commands/${encodeURIComponent(commandId)}/scan-progress`, this.#config.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: this.#config.agentId, ...progress }),
        signal: this.#requestSignal(),
      })
      if (!response.ok) console.warn(`[browser-agent] Backend rejected scan progress for command ${commandId}: HTTP ${response.status}`)
    } catch {
      console.warn(`[browser-agent] Could not report scan progress for command ${commandId}`)
    }
  }

  async #run(executor: CommandExecutor, statusConsumer: StatusConsumer): Promise<void> {
    while (!this.#stopController.signal.aborted) {
      const pendingResult = this.#pendingResult
      if (pendingResult) {
        const delivery = await this.#deliverResult(pendingResult)
        if (delivery !== 'RETRY') this.#pendingResult = null
      } else {
        const command = await this.#claimNext()
        if (command) {
          this.#pendingResult = await this.#execute(command, executor, statusConsumer)
          continue
        }
      }

      await this.#waitForNextPoll()
    }
  }

  async #claimNext(): Promise<BrowserAgentCommand | null> {
    const url = new URL('/api/v1/browser-agent/commands/next', this.#config.baseUrl)
    url.searchParams.set('agentId', this.#config.agentId)

    try {
      const response = await fetch(url, {
        signal: this.#requestSignal(),
      })

      if (response.status === 204 || !response.ok) {
        return null
      }

      return await response.json() as BrowserAgentCommand
    } catch {
      return null
    }
  }

  async #execute(
    command: BrowserAgentCommand,
    executor: CommandExecutor,
    statusConsumer: StatusConsumer,
  ): Promise<BrowserAgentCommandResult> {
    console.info(`[browser-agent] Executing command ${command.type} (${command.id})`)
    statusConsumer('BUSY')

    try {
      const result = await executor(command)
      return { commandId: command.id, status: 'SUCCEEDED', errorMessage: null, authorization: result?.authorization ?? null, resumes: result?.resumes ?? null, vacancies: result?.vacancies ?? null, application: result?.application ?? null, applicationBlocker: result?.applicationBlocker ?? null, vacancyPlainText: result?.vacancyPlainText ?? null }
    } catch (error: unknown) {
      const errorMessage = this.#errorMessage(error).slice(0, 1_000)
      console.error(`[browser-agent] Command ${command.id} failed: ${errorMessage}`)
      return { commandId: command.id, status: 'FAILED', errorMessage, authorization: null, resumes: null, vacancies: null }
    } finally {
      statusConsumer('READY')
    }
  }

  async #deliverResult(result: BrowserAgentCommandResult): Promise<ResultDelivery> {
    try {
      const response = await fetch(
        new URL(`/api/v1/browser-agent/commands/${encodeURIComponent(result.commandId)}/result`, this.#config.baseUrl),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            agentId: this.#config.agentId,
            status: result.status,
            errorMessage: result.errorMessage,
            authorization: result.authorization,
            resumes: result.resumes,
            vacancies: result.vacancies,
            application: result.application ?? null,
            applicationBlocker: result.applicationBlocker ?? null,
            vacancyPlainText: result.vacancyPlainText ?? null,
          }),
          signal: this.#requestSignal(),
        },
      )

      if (response.ok) {
        console.info(`[browser-agent] Command ${result.commandId} ${result.status.toLowerCase()}`)
        return 'DELIVERED'
      }

      if (response.status === 400 && result.status === 'SUCCEEDED') {
        this.#pendingResult = { ...result, status: 'FAILED', errorMessage: 'Backend отклонил формат результатов. Обновите агент и повторите сканирование.',
          authorization: null, resumes: null, vacancies: null, application: null }
      }
      return response.status === 404 || response.status === 409 ? 'DISCARD' : 'RETRY'
    } catch {
      return 'RETRY'
    }
  }

  async #waitForNextPoll(): Promise<void> {
    try {
      await delay(this.#config.commandPollingIntervalMs, undefined, {
        signal: this.#stopController.signal,
      })
    } catch (error: unknown) {
      if (!this.#stopController.signal.aborted) {
        throw error
      }
    }
  }

  #requestSignal(): AbortSignal {
    return AbortSignal.any([
      this.#stopController.signal,
      AbortSignal.timeout(this.#config.requestTimeoutMs),
    ])
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
