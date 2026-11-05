import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { env, platform } from 'node:process'

export interface BrowserConfig {
  profilesRootDirectory: string
  disableGpu: boolean
  launchTimeoutMs: number
}

function resolveLaunchTimeoutMs(): number {
  const configured = env.HH_CLICKER_CHROME_LAUNCH_TIMEOUT_MS
  if (!configured) return 30_000
  const timeout = Number(configured)
  if (!Number.isSafeInteger(timeout) || timeout < 1_000) {
    throw new Error('HH_CLICKER_CHROME_LAUNCH_TIMEOUT_MS must be an integer of at least 1000')
  }
  return timeout
}

function resolveApplicationDataDirectory(): string {
  switch (platform) {
    case 'win32':
      return env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support')
    default:
      return env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  }
}

function resolveProfilesRootDirectory(): string {
  const configuredDirectory = env.HH_CLICKER_BROWSER_PROFILE_DIR?.trim()

  if (configuredDirectory) {
    return resolve(configuredDirectory)
  }

  const applicationRoot = join(resolveApplicationDataDirectory(), 'HH Clicker')
  const currentDirectory = join(applicationRoot, 'data', 'browser-agent', 'profiles')
  const legacyDirectory = join(applicationRoot, 'browser-agent', 'profiles')

  return !existsSync(currentDirectory) && existsSync(legacyDirectory)
    ? legacyDirectory
    : currentDirectory
}

export const browserConfig: BrowserConfig = {
  profilesRootDirectory: resolveProfilesRootDirectory(),
  disableGpu: env.HH_CLICKER_CHROME_DISABLE_GPU === 'true',
  launchTimeoutMs: resolveLaunchTimeoutMs(),
}
