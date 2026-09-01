import { StringDecoder } from 'node:string_decoder'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import { spawnProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import type { BridgeRequest, BridgeResponse } from './desktop-script-provider-types'
import { RuntimeClientError } from './runtime-client-error'
import {
  FALLBACK_WINDOWS_EXECUTION_POLICY,
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  isExecutionPolicyBlocked,
  windowsPowerShellRuntimeArgs,
  type WindowsExecutionPolicy
} from './windows-powershell-execution-policy'

/** The all-pipes child `spawnProcess` returns; avoids a node:child_process import. */
type RuntimeChildProcess = ReturnType<typeof spawnProcess>

const REQUEST_TIMEOUT_MS = 30_000
const IDLE_SHUTDOWN_MS = 120_000
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024

/** Code the client keys on to fall back to the one-shot bridge for the session. */
export const RUNTIME_HOST_UNAVAILABLE = 'runtime_host_unavailable'

export type DesktopScriptRuntimeHostOptions = {
  spawn?: (spec: ProcessSpec) => RuntimeChildProcess
  powerShellPath?: () => string
  requestTimeoutMs?: number
  idleShutdownMs?: number
  warn?: (message: string) => void
}

type PendingRequest = {
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
 * Requests are strictly serialized: the protocol carries no request id because
 * only one operation is ever in flight, and native automation is not safe to
 * interleave anyway.
 */
export class DesktopScriptRuntimeHost {
  private child: RuntimeChildProcess | null = null
  private detachChild: (() => void) | null = null
  private decoder = new StringDecoder('utf8')
  private stdoutBuffer = ''
  private stderrText = ''
  private pending: PendingRequest | null = null
  private queueTail: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private policy: WindowsExecutionPolicy = PREFERRED_WINDOWS_EXECUTION_POLICY
  private policyRetryPending = false
  private childAnswered = false
  private unavailable = false
  private readonly requestTimeoutMs: number
  private readonly idleShutdownMs: number

  constructor(
    private readonly scriptPath: string,
    private readonly options: DesktopScriptRuntimeHostOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.idleShutdownMs = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS
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

  /** Stop the helper. A later request starts a fresh one. */
  dispose(): void {
    this.clearIdleTimer()
    this.stopChild()
    this.rejectPending(
      new RuntimeClientError('accessibility_error', 'desktop provider runtime host was shut down')
    )
  }

  private async send(request: BridgeRequest): Promise<BridgeResponse> {
    this.clearIdleTimer()
    try {
      return await this.sendOnce(request)
    } catch (error) {
      if (!this.policyRetryPending) {
        throw error
      }
      this.policyRetryPending = false
      this.policy = FALLBACK_WINDOWS_EXECUTION_POLICY
      this.warn(
        `runtime host start blocked at ${PREFERRED_WINDOWS_EXECUTION_POLICY}; retrying once with ${FALLBACK_WINDOWS_EXECUTION_POLICY}`
      )
      return await this.sendOnce(request)
    }
  }

  private sendOnce(request: BridgeRequest): Promise<BridgeResponse> {
    if (this.unavailable) {
      return Promise.reject(this.unavailableError('runtime host is unavailable'))
    }
    let child: RuntimeChildProcess
    try {
      child = this.ensureChild()
    } catch (error) {
      this.unavailable = true
      return Promise.reject(
        this.unavailableError(error instanceof Error ? error.message : String(error))
      )
    }
    return new Promise((resolve, reject) => {
      // Why kill rather than wait: a hung UI Automation call cannot be
      // cancelled, so the process itself is the only thing left to reclaim.
      const timer = setTimeout(() => {
        this.abortChild(
          new RuntimeClientError(
            'action_timeout',
            `desktop provider timed out after ${this.requestTimeoutMs}ms`
          )
        )
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending = { resolve, reject, timer }
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.abortChild(new RuntimeClientError('accessibility_error', error.message))
        }
      })
    })
  }

  private ensureChild(): RuntimeChildProcess {
    if (this.child) {
      return this.child
    }
    const spawn = this.options.spawn ?? spawnProcess
    const child = spawn({
      program: (this.options.powerShellPath ?? windowsPowerShellPath)(),
      args: windowsPowerShellRuntimeArgs(this.scriptPath, this.policy, ['-Serve']),
      env: process.env
    })
    this.decoder = new StringDecoder('utf8')
    this.stdoutBuffer = ''
    this.stderrText = ''
    this.childAnswered = false

    const onStdout = (chunk: Buffer | string): void => this.readStdout(chunk)
    const onStderr = (chunk: Buffer | string): void => {
      this.stderrText = `${this.stderrText}${chunk.toString()}`.slice(-4096)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.handleGone(child, signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`)
    const onError = (error: Error): void => this.handleGone(child, error.message)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', onExit)
    child.once('error', onError)
    // An unhandled stream error is an uncaught exception in the main process.
    child.stdin.on('error', () => {})
    this.detachChild = (): void => {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
      child.off('error', onError)
      child.on('error', () => {})
    }
    this.child = child
    return child
  }

  private readStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (this.stdoutBuffer.length > MAX_RESPONSE_BYTES) {
      this.abortChild(
        new RuntimeClientError(
          'accessibility_error',
          'desktop provider response exceeded the runtime host buffer'
        )
      )
      return
    }
    for (let newline = this.stdoutBuffer.indexOf('\n'); newline >= 0;) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) {
        this.deliver(line)
      }
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private deliver(line: string): void {
    this.childAnswered = true
    const pending = this.takePending()
    if (!pending) {
      return
    }
    try {
      pending.resolve(JSON.parse(line) as BridgeResponse)
    } catch (error) {
      pending.reject(
        new RuntimeClientError(
          'accessibility_error',
          `desktop provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    }
  }

  private handleGone(child: RuntimeChildProcess, detail: string): void {
    // A replaced child can still report; that must not fail the live one.
    if (this.child !== child) {
      return
    }
    const text = [detail, this.stderrText.trim()].filter(Boolean).join(': ')
    const answered = this.childAnswered
    this.releaseChild()
    if (
      !answered &&
      this.policy === PREFERRED_WINDOWS_EXECUTION_POLICY &&
      isExecutionPolicyBlocked(text)
    ) {
      this.policyRetryPending = true
      this.rejectPending(new RuntimeClientError('accessibility_error', text))
      return
    }
    if (!answered) {
      this.unavailable = true
      this.rejectPending(this.unavailableError(text))
      return
    }
    this.rejectPending(
      new RuntimeClientError('accessibility_error', `desktop provider runtime host exited: ${text}`)
    )
  }

  private abortChild(error: Error): void {
    this.stopChild()
    this.rejectPending(error)
  }

  private stopChild(): void {
    const child = this.child
    this.releaseChild()
    if (!child) {
      return
    }
    // Closing stdin ends the serve loop; the kill covers a wedged helper.
    try {
      child.stdin.end()
    } catch {
      /* already closed */
    }
    child.kill()
  }

  private releaseChild(): void {
    const detach = this.detachChild
    this.detachChild = null
    detach?.()
    this.child = null
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
    if (!this.child) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stopChild()
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

  private warn(message: string): void {
    ;(this.options.warn ?? ((text: string) => console.warn(`[computer-use] ${text}`)))(message)
  }
}
