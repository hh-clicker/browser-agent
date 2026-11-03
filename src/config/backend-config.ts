import { env } from 'node:process'

export interface BackendConfig {
  baseUrl: string
  agentId: string
  agentVersion: string
  heartbeatIntervalMs: number
  commandPollingIntervalMs: number
  requestTimeoutMs: number
}

function positiveInteger(value: string | undefined, fallback: number, variableName: string): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} must be a positive integer`)
  }

  return parsed
}

export const backendConfig: BackendConfig = {
  baseUrl: env.HH_CLICKER_BACKEND_URL?.trim() || 'http://localhost:8080',
  agentId: env.HH_CLICKER_AGENT_ID?.trim() || 'local-browser-agent',
  agentVersion: env.HH_CLICKER_AGENT_VERSION?.trim() || '0.0.0',
  heartbeatIntervalMs: positiveInteger(
    env.HH_CLICKER_HEARTBEAT_INTERVAL_MS,
    5_000,
    'HH_CLICKER_HEARTBEAT_INTERVAL_MS',
  ),
  commandPollingIntervalMs: positiveInteger(
    env.HH_CLICKER_COMMAND_POLLING_INTERVAL_MS,
    1_000,
    'HH_CLICKER_COMMAND_POLLING_INTERVAL_MS',
  ),
  requestTimeoutMs: positiveInteger(
    env.HH_CLICKER_REQUEST_TIMEOUT_MS,
    3_000,
    'HH_CLICKER_REQUEST_TIMEOUT_MS',
  ),
}
