import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'

export type HeadlessAutomationRunTarget = {
  workspaceId: string
  workspaceDisplayName: string | null
  terminalSessionId: string | null
  terminalPaneKey: string | null
  terminalPtyId: string | null
}

function persistHeadlessCompletion(
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>,
  result: AutomationDispatchResult
): void {
  void markDispatchResult(result).catch((error) => {
    console.error('[automations] failed to persist run completion:', error)
  })
}

export function observeHeadlessAutomationCompletion({
  automation,
  run,
  launch,
  target,
  precheckResult,
  markDispatchResult
}: {
  automation: Automation
  run: AutomationRun
  launch: HeadlessAutomationDispatchLaunch
  target: HeadlessAutomationRunTarget
  precheckResult: AutomationPrecheckResult | null
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
}): void {
  if (!launch.completion) {
    return
  }
  void launch.completion.then(
    (completion) => {
      const retainPotentiallyLiveRun =
        automation.workspaceMode === 'existing' && completion.observationVerdict === 'unverifiable'
      persistHeadlessCompletion(markDispatchResult, {
        runId: run.id,
        status: retainPotentiallyLiveRun ? 'dispatched' : completion.status,
        observationVerdict: completion.observationVerdict ?? null,
        ...target,
        precheckResult,
        outputSnapshot: completion.outputSnapshot ?? null,
        error: completion.error ?? null
      })
    },
    (error) => {
      const errorCode = error instanceof Error ? error.message.trim() : String(error).trim()
      const observedExit = errorCode === 'terminal_exited'
      if (!observedExit) {
        // Why a fixed sentence: transport tokens belong in logs, not run history.
        console.error('[automations] run completion observation failed:', error)
      }
      persistHeadlessCompletion(markDispatchResult, {
        runId: run.id,
        status:
          !observedExit && automation.workspaceMode === 'existing'
            ? 'dispatched'
            : 'dispatch_failed',
        observationVerdict: observedExit ? null : 'unverifiable',
        ...target,
        precheckResult,
        error: observedExit
          ? 'Automation terminal exited before the agent reported completion.'
          : 'Orca stopped watching this run before it reported completion.'
      })
    }
  )
}
