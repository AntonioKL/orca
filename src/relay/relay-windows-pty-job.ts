import { createRequire } from 'node:module'
import { relayLogLine } from './relay-diagnostic-log'

type ConptyNative = {
  assignCurrentProcessToJob: () => boolean
}

export type RelayWindowsPtyJobOutcome = 'assigned' | 'unavailable' | 'not-applicable'

const requireFromRelay = createRequire(__filename)

function loadConptyNative(): unknown {
  const { loadNativeModule } = requireFromRelay('node-pty/lib/utils') as {
    loadNativeModule: (name: string) => { module: unknown }
  }
  return loadNativeModule('conpty').module
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reportUnavailable(reason: string): RelayWindowsPtyJobOutcome {
  relayLogLine(`[relay] Windows kill-on-close job unavailable: ${reason}`)
  return 'unavailable'
}

export function assignRelayProcessToKillOnCloseJob(
  platform: NodeJS.Platform = process.platform,
  loadNative: () => unknown = loadConptyNative
): RelayWindowsPtyJobOutcome {
  if (platform !== 'win32') {
    return 'not-applicable'
  }

  let native: Partial<ConptyNative> | null
  try {
    native = loadNative() as Partial<ConptyNative> | null
  } catch (error) {
    return reportUnavailable(`ConPTY addon failed to load: ${errorMessage(error)}`)
  }
  if (typeof native?.assignCurrentProcessToJob !== 'function') {
    return reportUnavailable('ConPTY addon does not export assignCurrentProcessToJob')
  }

  try {
    return native.assignCurrentProcessToJob()
      ? 'assigned'
      : reportUnavailable('assignment was refused')
  } catch (error) {
    return reportUnavailable(`assignment failed: ${errorMessage(error)}`)
  }
}
