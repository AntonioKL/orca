import { spawnProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import { reportComputerDiagnostic } from './computer-sidecar-diagnostics'
import type { BridgeRequest, BridgeResponse } from './desktop-script-provider-types'
import {
  startServeChannel,
  type DesktopScriptServeChannel,
  type RuntimeProcessSpawn
} from './desktop-script-serve-channel'
import {
  MAX_START_ATTEMPTS,
  RuntimeHostAvailability,
  START_FAILURE_COOLDOWN_MS
} from './desktop-script-runtime-availability'
import { RuntimeClientError } from './runtime-client-error'
import {
  isExecutionPolicyBlocked,
  windowsPowerShellRuntimeArgs
} from './windows-powershell-execution-policy'

const REQUEST_TIMEOUT_MS = 30_000
const IDLE_SHUTDOWN_MS = 120_000

/** Code the client keys on to serve this one operation from the one-shot bridge. */
export const RUNTIME_HOST_UNAVAILABLE = 'runtime_host_unavailable'

export type DesktopScriptRuntimeHostOptions = {
  spawn?: RuntimeProcessSpawn
  powerShellPath?: () => string
  requestTimeoutMs?: number
  idleShutdownMs?: number
  cooldownMs?: number
  now?: () => number
  warn?: (message: string) => void
}

type PendingRequest = {
  id: number
  resolve: (response: BridgeResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export function isRuntimeHostUnavailable(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === RUNTIME_HOST_UNAVAILABLE
}

/**
 * One long-lived `runtime.ps1 -Serve` process serving every computer-use
 * operation over NDJSON on stdin/stdout.
 *
 * Why persistent: the one-shot bridge started a powershell.exe per click, and
 * each one re-emitted the script's inline `Add-Type` P/Invoke assembly, which
 * Defender for Endpoint reports as suspicious MSIL emission alongside the
 * screen capture. Compiling once per session collapses a burst of short-lived
 * PIDs into a single process.
 *
 * Requests are strictly serialized, and each carries an id the helper echoes.
 * Serialization alone would leave a single stray line answering every later
 * request with the previous response — silently acting on stale element
 * indexes, with no error raised — so the id is checked and a mismatch is fatal
 * to the child rather than merely logged.
 */
export class DesktopScriptRuntimeHost {
  private channel: DesktopScriptServeChannel | null = null
  private pending: PendingRequest | null = null
  private queueTail: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private childAnswered = false
  private disposed = false
  private nextRequestId = 1
  private readonly availability: RuntimeHostAvailability
  private readonly requestTimeoutMs: number
  private readonly idleShutdownMs: number

  constructor(
    private readonly scriptPath: string,
    private readonly options: DesktopScriptRuntimeHostOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.idleShutdownMs = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS
    this.availability = new RuntimeHostAvailability(
      options.cooldownMs ?? START_FAILURE_COOLDOWN_MS,
      options.now ?? Date.now,
      (message) => (options.warn ?? reportComputerDiagnostic)(message)
    )
  }

  request(request: BridgeRequest): Promise<BridgeResponse> {
    const run = (): Promise<BridgeResponse> => this.send(request)
    const result = this.queueTail ? this.queueTail.then(run, run) : run()
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.queueTail = tail
    void tail.finally(() => {
      if (this.queueTail !== tail) {
        return
      }
      this.queueTail = null
      this.armIdleTimer()
    })
    return result
  }

  /** Permanently stop this host. Callers build a new one for a new session. */
  dispose(): void {
    this.disposed = true
    this.clearIdleTimer()
    this.availability.clearCooldown()
    this.stopChannel()
    this.rejectPending(
      new RuntimeClientError('accessibility_error', 'desktop provider runtime host was shut down')
    )
  }

  private async send(request: BridgeRequest): Promise<BridgeResponse> {
    this.clearIdleTimer()
    // Why checked here and not only on entry: requests queue, and dispose can
    // land while one waits its turn. Without this a teardown respawns a helper.
    if (this.disposed) {
      throw this.unavailableError('runtime host was disposed')
    }
    const cooldown = this.availability.remainingCooldown()
    if (cooldown > 0) {
      throw this.unavailableError(`retrying the runtime host in ${cooldown}ms`)
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      try {
        const response = await this.sendOnce(request)
        this.availability.recordSuccess()
        return response
      } catch (error) {
        lastError = error
        if (this.availability.policyRetryPending) {
          this.availability.escalateExecutionPolicy()
          continue
        }
        // A helper that answered and then died is a crash, not a bad start: the
        // caller sees it and the next operation gets a fresh process — unless it
        // keeps happening, which is thrash the one-shot bridge should absorb.
        if (!isRuntimeHostUnavailable(error)) {
          if (this.availability.exhausted) {
            this.availability.enterCooldown()
          }
          throw error
        }
        this.availability.warn(
          `runtime host failed to start (attempt ${attempt}/${MAX_START_ATTEMPTS}): ${errorText(error)}`
        )
      }
    }
    this.availability.enterCooldown()
    throw lastError
  }

  private sendOnce(request: BridgeRequest): Promise<BridgeResponse> {
    let channel: DesktopScriptServeChannel
    try {
      channel = this.ensureChannel()
    } catch (error) {
      this.availability.recordFailure()
      return Promise.reject(this.unavailableError(errorText(error)))
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      // Why kill rather than wait: a hung UI Automation call cannot be
      // cancelled, so the process itself is the only thing left to reclaim.
      const timer = setTimeout(() => {
        this.abortChannel(
          new RuntimeClientError(
            'action_timeout',
            `desktop provider timed out after ${this.requestTimeoutMs}ms`
          )
        )
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending = { id, resolve, reject, timer }
      channel.write(`${JSON.stringify({ ...request, requestId: id })}\n`, (error) =>
        this.abortChannel(new RuntimeClientError('accessibility_error', error.message))
      )
    })
  }

  private ensureChannel(): DesktopScriptServeChannel {
    if (this.channel) {
      return this.channel
    }
    this.childAnswered = false
    const channel: DesktopScriptServeChannel = startServeChannel(
      {
        program: (this.options.powerShellPath ?? windowsPowerShellPath)(),
        args: windowsPowerShellRuntimeArgs(this.scriptPath, this.availability.executionPolicy, [
          '-Serve'
        ]),
        env: process.env
      },
      this.options.spawn ?? spawnProcess,
      {
        onLine: (line) => this.deliver(line),
        // A replaced channel can still report; that must not fail the live one.
        onGone: (detail) => {
          if (this.channel === channel) {
            this.handleGone(detail)
          }
        },
        onOverflow: () =>
          this.abortChannel(
            new RuntimeClientError(
              'accessibility_error',
              'desktop provider response exceeded the runtime host buffer'
            )
          )
      }
    )
    this.channel = channel
    return channel
  }

  private deliver(line: string): void {
    let parsed: BridgeResponse
    try {
      parsed = JSON.parse(line) as BridgeResponse
    } catch {
      // Not a response at all — a PowerShell banner, a stray write. Dropping it
      // is safe now that the id below is what decides which request is answered,
      // and it keeps a chatty console from making the helper unusable.
      return
    }
    const pending = this.pending
    if (!pending || parsed.requestId !== pending.id) {
      // One unmatched reply would otherwise shift every later response by one.
      this.abortChannel(
        new RuntimeClientError(
          'accessibility_error',
          'desktop provider response did not match the pending request'
        )
      )
      return
    }
    // Only a reply this host can prove is its own counts as the helper working.
    this.childAnswered = true
    this.pending = null
    clearTimeout(pending.timer)
    const { requestId: _echoed, ...response } = parsed
    pending.resolve(response)
  }

  private handleGone(detail: string): void {
    const answered = this.childAnswered
    this.channel = null
    this.availability.recordFailure()
    if (!answered && this.availability.atPreferredPolicy && isExecutionPolicyBlocked(detail)) {
      this.availability.requestPolicyRetry()
      this.rejectPending(new RuntimeClientError('accessibility_error', detail))
      return
    }
    if (!answered) {
      this.rejectPending(this.unavailableError(detail))
      return
    }
    this.rejectPending(
      new RuntimeClientError(
        'accessibility_error',
        `desktop provider runtime host exited: ${detail}`
      )
    )
  }

  private abortChannel(error: Error): void {
    this.stopChannel()
    this.rejectPending(error)
  }

  private stopChannel(): void {
    const channel = this.channel
    this.channel = null
    channel?.stop()
  }

  private takePending(): PendingRequest | null {
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
    }
    return pending
  }

  private rejectPending(error: Error): void {
    this.takePending()?.reject(error)
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (!this.channel) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stopChannel()
    }, this.idleShutdownMs)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private unavailableError(message: string): RuntimeClientError {
    return new RuntimeClientError(
      RUNTIME_HOST_UNAVAILABLE,
      `desktop provider runtime host could not start: ${message}`
    )
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
