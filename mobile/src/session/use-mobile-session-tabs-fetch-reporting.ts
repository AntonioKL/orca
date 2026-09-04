import { useCallback, useMemo, useReducer, type MutableRefObject } from 'react'
import type { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import {
  NO_SESSION_TABS_LOAD_FAILURE,
  nextSessionTabsLoadFailure,
  type SessionTabsLoadFailure
} from './session-tabs-load-surface'

type DiagnosticTabsSnapshot = Parameters<MobileTerminalDiagnostics['tabsFetchSucceeded']>[0]

type ScopedFailure = SessionTabsLoadFailure & { worktreeId: string }

/** Forwards session-tabs fetch outcomes to the screen's diagnostics recorder and
 *  keeps the consecutive-failure run the screen needs to stop showing a spinner
 *  for a snapshot that never lands. Split out of the session route so the
 *  reconciliation wiring there stays a single call rather than five one-line
 *  callbacks. */
export function useMobileSessionTabsFetchReporting<Result extends DiagnosticTabsSnapshot>(args: {
  worktreeId: string
  diagnosticsRef: MutableRefObject<MobileTerminalDiagnostics>
}): {
  reporting: {
    onFetchStarted: () => void
    onFetchSucceeded: (result: Result) => void
    onFetchFailed: (code: string) => void
    onFetchErrored: (error: unknown) => void
  }
  loadFailure: SessionTabsLoadFailure
  clearLoadFailure: () => void
} {
  const { worktreeId, diagnosticsRef } = args
  // Why: the route is reused across workspaces, so a failure run from the previous
  // one must not decide this one's surface.
  const [scoped, recordOutcome] = useReducer(
    (current: ScopedFailure, code: string | null): ScopedFailure => ({
      worktreeId,
      ...nextSessionTabsLoadFailure(
        current.worktreeId === worktreeId ? current : NO_SESSION_TABS_LOAD_FAILURE,
        code
      )
    }),
    { worktreeId, ...NO_SESSION_TABS_LOAD_FAILURE }
  )
  const reporting = useMemo(
    () => ({
      onFetchStarted: () => diagnosticsRef.current.tabsFetchStarted(worktreeId),
      onFetchSucceeded: (result: Result) => {
        diagnosticsRef.current.tabsFetchSucceeded(result)
        recordOutcome(null)
      },
      onFetchFailed: (code: string) => {
        diagnosticsRef.current.tabsFetchFailed(code)
        recordOutcome(code)
      },
      onFetchErrored: (error: unknown) => {
        diagnosticsRef.current.tabsFetchErrored(error)
        recordOutcome('unavailable')
      }
    }),
    [diagnosticsRef, worktreeId]
  )
  return {
    reporting,
    loadFailure: scoped.worktreeId === worktreeId ? scoped : NO_SESSION_TABS_LOAD_FAILURE,
    clearLoadFailure: useCallback(() => recordOutcome(null), [])
  }
}
