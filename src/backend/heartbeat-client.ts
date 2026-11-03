import { setTimeout as delay } from 'node:timers/promises'
import { GenerationStatusProbe } from '../generation/status.js'

import type { AgentRuntimeStatus } from '../agent/agent-runtime-status.js'
import type { BackendConfig } from '../config/backend-config.js'

type StatusProvider = () => AgentRuntimeStatus
type BrowserStateProvider = () => { browserOpen: boolean; activeProfileId: string | null }

export class HeartbeatClient {
  readonly #config: BackendConfig
  readonly #stopController = new AbortController()
  #running: Promise<void> | null = null
  #connected = false
  #failureReported = false
  readonly #generation = new GenerationStatusProbe()

  constructor(config: BackendConfig) {
    this.#config = config
  }

  start(statusProvider: StatusProvider, browserStateProvider: BrowserStateProvider): void {
    if (this.#running) {
      return
    }

    this.#running = this.#run(statusProvider, browserStateProvider)
  }

  async stop(): Promise<void> {
    this.#stopController.abort()

    if (this.#running) {
      await this.#running
      this.#running = null
    }
  }

  async #run(statusProvider: StatusProvider, browserStateProvider: BrowserStateProvider): Promise<void> {
    while (!this.#stopController.signal.aborted) {
      await this.#send(statusProvider(), browserStateProvider())

      try {
        await delay(this.#config.heartbeatIntervalMs, undefined, {
          signal: this.#stopController.signal,
        })
      } catch (error: unknown) {
        if (!this.#stopController.signal.aborted) {
          throw error
        }
      }
    }
  }

  async #send(status: AgentRuntimeStatus, browserState: ReturnType<BrowserStateProvider>): Promise<void> {
    const requestSignal = AbortSignal.any([
      this.#stopController.signal,
      AbortSignal.timeout(this.#config.requestTimeoutMs),
    ])

    try {
      const response = await fetch(new URL('/api/v1/browser-agent/heartbeat', this.#config.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentId: this.#config.agentId,
          version: this.#config.agentVersion,
          status,
          browserOpen: browserState.browserOpen,
          activeProfileId: browserState.activeProfileId,
          generation: this.#generation.snapshot,
        }),
        signal: requestSignal,
      })

      if (!response.ok) {
        throw new Error(`Backend returned HTTP ${response.status}`)
      }
      const body = await response.json() as { generationCheckId?: unknown }
      if (typeof body.generationCheckId === 'string' && /^[a-f0-9-]{36}$/i.test(body.generationCheckId)) {
        this.#generation.refresh(body.generationCheckId, this.#stopController.signal)
      }

      if (!this.#connected) {
        console.info(`[browser-agent] Connected to backend: ${this.#config.baseUrl}`)
      }

      this.#connected = true
      this.#failureReported = false
    } catch (error: unknown) {
      if (this.#stopController.signal.aborted) {
        return
      }

      this.#connected = false

      if (!this.#failureReported) {
        console.warn(`[browser-agent] Backend is unavailable: ${this.#errorMessage(error)}`)
        this.#failureReported = true
      }
    }
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
