import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { WorktreeAgentActivitySummary } from './worktree-agent-activity-summary'

export function applyLiveAgentState(
  summary: WorktreeAgentActivitySummary,
  entry: Pick<AgentStatusEntry, 'state' | 'workingMode' | 'interrupted'>
): void {
  if (entry.state === 'blocked' || entry.state === 'waiting') {
    summary.hasPermission = true
  } else if (entry.interrupted === true) {
    // Interrupted is encoded as done, so it must be checked first.
    summary.hasInterrupted = true
  } else if (entry.state === 'working') {
    if (entry.workingMode === 'monitoring') {
      summary.hasLiveMonitoring = true
    } else {
      summary.hasLiveWorking = true
    }
  } else if (entry.state === 'done') {
    summary.hasLiveDone = true
  }
}
