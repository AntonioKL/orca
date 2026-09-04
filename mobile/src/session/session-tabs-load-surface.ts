/**
 * Whether the session screen is still waiting for its first tab snapshot or has
 * given up on one. Repeated load failures used to be recorded in diagnostics only,
 * so a workspace whose snapshot the host or the shell kept rejecting sat on the
 * "Loading tabs" spinner with no error and no way to retry.
 */
export type SessionTabsLoadFailure = {
  /** Consecutive failed loads since the last accepted snapshot. */
  attempts: number
  code: string | null
}

export const NO_SESSION_TABS_LOAD_FAILURE: SessionTabsLoadFailure = { attempts: 0, code: null }

/** Polls run every 2s; two failures keeps one blip from flashing an error. */
export const SESSION_TABS_LOAD_FAILURE_ATTEMPTS = 2

export function nextSessionTabsLoadFailure(
  current: SessionTabsLoadFailure,
  code: string | null
): SessionTabsLoadFailure {
  return code === null ? NO_SESSION_TABS_LOAD_FAILURE : { attempts: current.attempts + 1, code }
}

export function sessionTabsLoadSurface(args: {
  connected: boolean
  terminalsLoaded: boolean
  visibleTabCount: number
  failure: SessionTabsLoadFailure
}): 'loading' | 'error' | 'ready' {
  if (!args.connected || args.terminalsLoaded || args.visibleTabCount > 0) {
    return 'ready'
  }
  return args.failure.attempts >= SESSION_TABS_LOAD_FAILURE_ATTEMPTS ? 'error' : 'loading'
}
