import { app, type BrowserWindow } from 'electron'
import { reportSecretProtectionGap } from './secret-protection-report'

/**
 * Run the at-rest secret protection report once the app is up, never before.
 *
 * Why deferred: `describeProtectionGap()` asks Electron `safeStorage` whether the OS
 * keyring is usable, and on Linux that is a blocking D-Bus round trip to
 * `org.freedesktop.secrets`. A keyring that is present but locked with no unlock
 * prompter never answers, so the call sits until D-Bus times it out — measured at 76s
 * to first window on Ubuntu 24.04, against 1s on the build before the report existed
 * (STA-5765). Run before the first window, that reads to the user as "the app will not
 * open"; the window is gated behind a diagnostic whose result nothing on the startup
 * path consumes.
 */

// Why a fallback as well as the window event: `ready-to-show` can fail to fire at all
// when the GPU/driver cannot present (see main-window-state-lifecycle), and headless
// serve has no window to wait on.
const REPORT_FALLBACK_MS = 15_000

export function scheduleSecretProtectionGapReport(options: {
  dataFile: string
  force?: boolean
  log?: (message: string) => void
}): void {
  let ran = false
  const run = (): void => {
    if (ran) {
      return
    }
    ran = true
    clearTimeout(fallback)
    // Why setImmediate: keep the blocking keyring probe off the event handler that
    // reveals the window, so the reveal paints first.
    setImmediate(() => {
      reportSecretProtectionGap(options)
    })
  }

  const fallback = setTimeout(run, REPORT_FALLBACK_MS)
  fallback.unref?.()
  app.once('browser-window-created', (_event: Electron.Event, window: BrowserWindow) => {
    window.once('ready-to-show', run)
  })
}
