/**
 * Writes a startup command into a local PTY once the shell reports readiness.
 */
import type * as pty from 'node-pty'
import type { PtySlaveLineEditorProbe } from '../../shared/pty-slave-line-discipline-echo'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  createLineEditorReadyOutputScanState,
  scanForLineEditorReadyOutput
} from '../line-editor-ready-output-scanner'

export const STARTUP_COMMAND_READY_MAX_WAIT_MS = 1500
const POST_SHELL_READY_STARTUP_COMMAND_DELAY_MS = 30
const POST_SHELL_READY_STARTUP_COMMAND_FALLBACK_MS = 200
const LINE_EDITOR_PROBE_INITIAL_RETRY_MS = 10
const LINE_EDITOR_PROBE_MAX_RETRY_MS = 200

export type ShellReadySignal = {
  postMarkerBytesObserved: boolean
}

export function writeStartupCommandWhenShellReady(
  readyPromise: Promise<void | ShellReadySignal>,
  proc: pty.IPty,
  startupCommand: string,
  onExit: (cleanup: () => void) => void,
  // Why: only shells with bracketed-paste active (see isBracketedPasteSafeShell) accept the wrapper; others use the raw path so ESC[200~ isn't echoed.
  options: {
    bracketedPasteSafe?: boolean
    lineEditorProbe?: PtySlaveLineEditorProbe
  } = {}
): void {
  let sent = false
  let generation = 0
  let lineEditorOutputObserved = false
  let shellReadyResolved = false
  let shellReadySignal: void | ShellReadySignal
  let lineEditorProbeAttempt = 0
  let lineEditorProbeTimer: ReturnType<typeof setTimeout> | null = null
  let postReadyTimer: ReturnType<typeof setTimeout> | null = null
  let postReadyDataDisposable: { dispose: () => void } | null = null

  const cleanup = (): void => {
    sent = true
    generation += 1
    if (lineEditorProbeTimer !== null) {
      clearTimeout(lineEditorProbeTimer)
      lineEditorProbeTimer = null
    }
    if (postReadyTimer !== null) {
      clearTimeout(postReadyTimer)
      postReadyTimer = null
    }
    postReadyDataDisposable?.dispose()
    postReadyDataDisposable = null
  }

  const flush = (): void => {
    if (sent) {
      return
    }
    sent = true
    generation += 1
    postReadyDataDisposable?.dispose()
    postReadyDataDisposable = null
    if (lineEditorProbeTimer !== null) {
      clearTimeout(lineEditorProbeTimer)
      lineEditorProbeTimer = null
    }
    if (postReadyTimer !== null) {
      clearTimeout(postReadyTimer)
      postReadyTimer = null
    }
    // Why: run in the same interactive shell (not `shell -c`) so the session survives after the agent exits.
    // Why CR on Windows: PSReadLine/cmd.exe submit on `\r`, not LF; POSIX treats either as Enter under ICRNL.
    const submit = process.platform === 'win32' ? '\r' : '\n'
    // Why: single write after the ready barrier avoids incremental-paste char drops; multiline is bracketed-paste wrapped so newlines don't submit early.
    proc.write(
      buildStartupCommandSubmission(startupCommand, {
        submit,
        bracketedPasteSafe: options.bracketedPasteSafe === true
      })
    )
  }

  const schedulePostReadyFlush = (): void => {
    postReadyTimer = setTimeout(flush, POST_SHELL_READY_STARTUP_COMMAND_DELAY_MS)
  }

  const useLegacyReadiness = (signal: void | ShellReadySignal): void => {
    if (signal?.postMarkerBytesObserved === true) {
      schedulePostReadyFlush()
      return
    }
    postReadyDataDisposable = proc.onData(() => {
      postReadyDataDisposable?.dispose()
      postReadyDataDisposable = null
      if (postReadyTimer !== null) {
        clearTimeout(postReadyTimer)
      }
      schedulePostReadyFlush()
    })
    postReadyTimer = setTimeout(() => {
      postReadyDataDisposable?.dispose()
      postReadyDataDisposable = null
      postReadyTimer = null
      flush()
    }, POST_SHELL_READY_STARTUP_COMMAND_FALLBACK_MS)
  }

  const waitForLineEditor = (signal: void | ShellReadySignal): void => {
    const probe = options.lineEditorProbe
    if (!probe || sent) {
      return
    }
    const probeGeneration = generation
    void probe()
      .then((state) => {
        if (sent || probeGeneration !== generation) {
          return
        }
        if (state === 'line-editor') {
          flush()
          return
        }
        if (state === 'unavailable') {
          useLegacyReadiness(signal)
          return
        }
        const retryMs = Math.min(
          LINE_EDITOR_PROBE_INITIAL_RETRY_MS * 2 ** lineEditorProbeAttempt,
          LINE_EDITOR_PROBE_MAX_RETRY_MS
        )
        lineEditorProbeAttempt += 1
        lineEditorProbeTimer = setTimeout(() => {
          lineEditorProbeTimer = null
          waitForLineEditor(signal)
        }, retryMs)
      })
      .catch(() => {
        if (sent || probeGeneration !== generation) {
          return
        }
        lineEditorProbeTimer = setTimeout(() => {
          lineEditorProbeTimer = null
          waitForLineEditor(signal)
        }, LINE_EDITOR_PROBE_MAX_RETRY_MS)
      })
  }

  if (options.lineEditorProbe) {
    const lineEditorOutputScanState = createLineEditorReadyOutputScanState()
    postReadyDataDisposable = proc.onData((data) => {
      if (!scanForLineEditorReadyOutput(lineEditorOutputScanState, data)) {
        return
      }
      lineEditorOutputObserved = true
      if (shellReadyResolved) {
        postReadyDataDisposable?.dispose()
        postReadyDataDisposable = null
        waitForLineEditor(shellReadySignal)
      }
    })
  }

  readyPromise.then((signal) => {
    if (sent) {
      return
    }
    if (options.lineEditorProbe) {
      shellReadySignal = signal
      shellReadyResolved = true
      if (lineEditorOutputObserved) {
        postReadyDataDisposable?.dispose()
        postReadyDataDisposable = null
        waitForLineEditor(signal)
      }
    } else {
      useLegacyReadiness(signal)
    }
  })
  onExit(cleanup)
}
