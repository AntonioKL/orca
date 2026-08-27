import { isCurrentRunCoordinator } from '../../orchestration/run-coordinator-authority'
import type { RunRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'

export function resolveRunCoordinatorIdentity(
  runtime: OrcaRuntimeService,
  handle: string,
  paneKey = runtime.getTerminalPaneKey(handle)
) {
  const authority = runtime.getOrchestrationDispatchAuthority(handle)
  return {
    handle,
    paneKey,
    processIncarnation:
      authority?.processIncarnation ?? runtime.getTerminalProcessIncarnation(handle),
    hostScope: authority?.hostScope ? JSON.stringify(authority.hostScope) : null
  }
}

export function isCallerCurrentRunCoordinator(
  runtime: OrcaRuntimeService,
  run: RunRow,
  handle: string,
  paneKey?: string | null
): boolean {
  return isCurrentRunCoordinator(
    run,
    resolveRunCoordinatorIdentity(runtime, handle, paneKey ?? runtime.getTerminalPaneKey(handle))
  )
}
