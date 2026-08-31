import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../shared/automations-types'
import type { Store } from '../persistence'

const LEGACY_UNVERIFIABLE_ERRORS = new Set([
  'terminal_handle_stale',
  'terminal_not_found',
  'timeout'
])

function isLegacyUnverifiableRun(run: AutomationRun): boolean {
  return (
    run.status === 'dispatch_failed' &&
    typeof run.error === 'string' &&
    LEGACY_UNVERIFIABLE_ERRORS.has(run.error.trim())
  )
}

export function findPotentiallyLiveAutomationRun(
  automation: Automation,
  currentRunId: string,
  runs: readonly AutomationRun[]
): AutomationRun | null {
  if (automation.workspaceMode !== 'existing' || automation.workspaceId === null) {
    return null
  }
  return (
    runs.find(
      (run) =>
        run.id !== currentRunId &&
        run.workspaceId === automation.workspaceId &&
        (run.observationVerdict === 'unverifiable' ||
          run.status === 'dispatching' ||
          run.status === 'dispatched' ||
          isLegacyUnverifiableRun(run))
    ) ?? null
  )
}

export function pinUnverifiableAutomationRun(store: Store, run: AutomationRun): void {
  if (
    (run.observationVerdict !== 'unverifiable' && !isLegacyUnverifiableRun(run)) ||
    !isFinalAutomationRunStatus(run.status)
  ) {
    return
  }
  store.updateAutomationRun({
    runId: run.id,
    status: 'dispatched',
    observationVerdict: 'unverifiable',
    workspaceId: run.workspaceId,
    error: isLegacyUnverifiableRun(run)
      ? 'Orca stopped watching this run before it reported completion.'
      : run.error
  })
}
