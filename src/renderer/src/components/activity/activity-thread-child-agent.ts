import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentPaneThread } from './activity-thread-types'

export function isChildAgentEntry(entry: AgentStatusEntry | null | undefined): boolean {
  if (!entry?.orchestration) {
    return false
  }
  const orch = entry.orchestration
  if (orch.parentPaneKey && orch.parentPaneKey !== entry.paneKey) {
    return true
  }
  if (orch.parentTerminalHandle && orch.parentTerminalHandle !== entry.terminalHandle) {
    return true
  }
  if (orch.coordinatorHandle && orch.coordinatorHandle !== entry.terminalHandle) {
    return true
  }
  return false
}

export function isChildAgentThread(thread: AgentPaneThread): boolean {
  if (isChildAgentEntry(thread.currentAgentEntry)) {
    return true
  }
  if (isChildAgentEntry(thread.latestEvent?.entry)) {
    return true
  }
  return thread.events.some((event) => isChildAgentEntry(event.entry))
}
