import type { AgentRuntimeStatus } from './agent/agent-runtime-status.js'
import type { BrowserAgentCommand, BrowserCommandExecutionResult } from './backend/browser-agent-command.js'
import { CommandClient } from './backend/command-client.js'
import { HeartbeatClient } from './backend/heartbeat-client.js'
import { BrowserManager } from './browser/browser-manager.js'
import { backendConfig } from './config/backend-config.js'
import { browserConfig } from './config/browser-config.js'
import { prepareCoverLetter } from './generation/cover-letter.js'

const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

function waitForShutdown(): Promise<string> {
  return new Promise((resolve) => {
    for (const signal of shutdownSignals) {
      process.once(signal, () => resolve(signal))
    }
    if (process.env.HH_CLICKER_LAUNCHER_MANAGED === 'true') {
      process.stdin.setEncoding('utf8')
      process.stdin.once('data', (value: string) => {
        if (value.trim() === 'shutdown') resolve('launcher request')
      })
      process.stdin.once('end', () => resolve('launcher disconnect'))
      process.stdin.resume()
    }
  })
}

const browserManager = new BrowserManager(browserConfig)
const heartbeatClient = new HeartbeatClient(backendConfig)
const commandClient = new CommandClient(backendConfig)
let runtimeStatus: AgentRuntimeStatus = 'CONNECTING'

async function executeCommand(command: BrowserAgentCommand): Promise<BrowserCommandExecutionResult | void> {
  const commandType: string = command.type

  switch (commandType) {
    case 'OPEN_BROWSER':
      if (!command.payload) throw new Error('OPEN_BROWSER command has no profile payload')
      await browserManager.open(command.payload)
      return { authorization: await browserManager.checkAuthorization(command.payload.profileId) }
    case 'CHECK_AUTHORIZATION':
      if (!command.payload) throw new Error('CHECK_AUTHORIZATION command has no profile payload')
      return { authorization: await browserManager.checkAuthorization(command.payload.profileId) }
    case 'DISCOVER_RESUMES':
      if (!command.payload) throw new Error('DISCOVER_RESUMES command has no profile payload')
      return browserManager.discoverResumes(command.payload.profileId, command.payload.url)
    case 'SCAN_SEARCH':
      if (!command.payload?.url || !command.payload.pagesLimit) throw new Error('SCAN_SEARCH command has no search payload')
      return browserManager.scanSearch(command.payload.profileId, command.payload.url, command.payload.pagesLimit,
        progress => commandClient.reportSearchProgress(command.id, progress))
    case 'APPLY_VACANCY':
      if (!command.payload?.application) throw new Error('APPLY_VACANCY command has no task payload')
      if (command.payload.application.mode === 'DRY_RUN') {
        return browserManager.collectVacancyText(command.payload.application,
          () => commandClient.applicationControl(command.id))
      }
      return await browserManager.apply(command.payload.application, {
        allowed: () => commandClient.applicationControl(command.id),
        permit: () => commandClient.applicationControl(command.id, true),
        prepareLetter: async plainText => {
          const prepared = await prepareCoverLetter(command.payload!.application!, plainText,
            () => commandClient.applicationControl(command.id))
          if (!prepared || !await commandClient.prepareApplicationLetter(command.id, prepared)) return null
          return prepared
        },
      })
    case 'INSPECT_APPLICATION':
      if (!command.payload?.url || !command.payload.vacancyId) throw new Error('INSPECT_APPLICATION command has no vacancy payload')
      return { application: await browserManager.inspectApplication(command.payload.profileId, command.payload.url) }
    case 'OPEN_URL':
      if (!command.payload?.url) throw new Error('OPEN_URL command has no URL payload')
      await browserManager.openUrl(command.payload.profileId, command.payload.url)
      return
    case 'CLOSE_BROWSER':
      await browserManager.close()
      return
    default:
      throw new Error(`Unsupported Browser Agent command: ${commandType}`)
  }
}

try {
  console.info('[browser-agent] Started')
  heartbeatClient.start(
    () => runtimeStatus,
    () => ({ browserOpen: browserManager.isOpen, activeProfileId: browserManager.activeProfileId }),
  )
  commandClient.start(executeCommand, (status) => { runtimeStatus = status })
  runtimeStatus = 'READY'

  const shutdownReason = await waitForShutdown()
  console.info(`[browser-agent] Received ${shutdownReason}, shutting down`)
} catch (error: unknown) {
  console.error('[browser-agent] Failed', error)
  process.exitCode = 1
} finally {
  // Closing the page interrupts a long scan instead of waiting for all remaining pages on Ctrl+C.
  await Promise.all([commandClient.stop(), browserManager.close()])
  await heartbeatClient.stop()
  await browserManager.close()
}
