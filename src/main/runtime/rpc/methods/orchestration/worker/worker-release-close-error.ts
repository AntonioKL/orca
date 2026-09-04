function isTransientWorkerTerminalCloseError(reason: string): boolean {
  return /disposed|not connected|unavailable/i.test(reason)
}

/** The close found nothing to close. Against a host-certified exit that is the goal state, not new
 *  doubt: a retry only aims the same dead handle at the same absent terminal, forever. */
function isMissingWorkerTerminalCloseError(reason: string): boolean {
  return /handle_stale|stale handle|disposed|not found|no such terminal/i.test(reason)
}

export function classifyWorkerTerminalCloseError(error: unknown): {
  reason: string
  transient: boolean
  alreadyGone: boolean
} {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    reason,
    transient: isTransientWorkerTerminalCloseError(reason),
    alreadyGone: isMissingWorkerTerminalCloseError(reason)
  }
}

export const TRANSIENT_WORKER_RELEASE_RECOVERY =
  'The owning endpoint is temporarily unavailable; recovery will retry this release after reconnect without another coordinator decision.'
