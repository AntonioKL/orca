function isTransientWorkerTerminalCloseError(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error)
  return /disposed|not connected|unavailable/i.test(reason)
}

export function classifyWorkerTerminalCloseError(error: unknown): {
  reason: string
  transient: boolean
} {
  return {
    reason: error instanceof Error ? error.message : String(error),
    transient: isTransientWorkerTerminalCloseError(error)
  }
}

export const TRANSIENT_WORKER_RELEASE_RECOVERY =
  'The owning endpoint is temporarily unavailable; recovery will retry this release after reconnect without another coordinator decision.'
