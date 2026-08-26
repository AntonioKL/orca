import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/**
 * Bookkeeping for tabs whose PTY went away without a host vouching for its death.
 *
 * `docs/reference/ssh-execution-boundary.md`: loss of contact is `unverifiable`,
 * never `exited`. Orca's tab-cleanup paths had no way to express that, so a
 * whole execution host disappearing at once (a WSL distro shutdown) read as 23
 * separate "this tab is finished" signals and the records were deleted (#16391).
 */
export function createTerminalUnverifiedPtyLossActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'markUnverifiedPtyLoss'> {
  return {
    markUnverifiedPtyLoss: (tabId) => {
      set((s) =>
        s.unverifiedPtyLossTabIds[tabId]
          ? {}
          : { unverifiedPtyLossTabIds: { ...s.unverifiedPtyLossTabIds, [tabId]: true } }
      )
    }
  }
}

/** Drops the marker for tabs that rebound a PTY, were closed, or were swept. */
export function omitUnverifiedPtyLossTabIds(
  unverifiedPtyLossTabIds: Readonly<Record<string, true>>,
  tabIds: Iterable<string>
): Record<string, true> {
  let next: Record<string, true> | null = null
  for (const tabId of tabIds) {
    if (!unverifiedPtyLossTabIds[tabId]) {
      continue
    }
    next ??= { ...unverifiedPtyLossTabIds }
    delete next[tabId]
  }
  return next ?? unverifiedPtyLossTabIds
}
