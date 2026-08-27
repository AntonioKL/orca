import type { ChildProcess } from 'node:child_process'

const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024

type UnrefableChildStderr = NonNullable<ChildProcess['stderr']> & {
  unref?: () => void
}

type DaemonExitListener = (exitCode: number | null, signal: NodeJS.Signals | null) => void

type ObservableDaemonChild = {
  stderr: UnrefableChildStderr | null
  on(event: 'exit', listener: DaemonExitListener): unknown
  off(event: 'exit', listener: DaemonExitListener): unknown
}

export type DaemonChildExitObservation = {
  verdict: 'exited'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
}

export type DaemonChildExitObserver = {
  startupStderrTail(): string
  markReady(): void
  stop(options?: { destroyStderr?: boolean }): void
}

export function observeDaemonChildExit(
  child: ObservableDaemonChild,
  recordExit: (observation: DaemonChildExitObservation) => void,
  maxStderrBytes = DEFAULT_STDERR_TAIL_BYTES
): DaemonChildExitObserver {
  let stderrTail = Buffer.alloc(0)
  let ready = false
  let stopped = false

  const onStderr = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderrTail = Buffer.concat([stderrTail, bytes]).subarray(-maxStderrBytes)
  }
  const onStderrError = (): void => {}
  const onProcessExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (stopped || !ready) {
      return
    }
    stopped = true
    child.off('exit', onProcessExit)
    child.stderr?.off('data', onStderr)
    child.stderr?.off('error', onStderrError)
    try {
      recordExit({
        verdict: 'exited',
        exitCode,
        signal,
        stderrTail: stderrTail.toString('utf8').trim()
      })
    } catch {
      // Diagnostics must never escape daemon lifecycle handling.
    }
  }

  child.stderr?.on('data', onStderr)

  return {
    startupStderrTail(): string {
      return stderrTail.toString('utf8').trim()
    },
    markReady(): void {
      if (ready || stopped) {
        return
      }
      ready = true
      child.stderr?.on('error', onStderrError)
      child.stderr?.unref?.()
      child.on('exit', onProcessExit)
    },
    stop(options = {}): void {
      if (stopped) {
        return
      }
      stopped = true
      child.off('exit', onProcessExit)
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
      if (options.destroyStderr) {
        child.stderr?.destroy()
      }
    }
  }
}
