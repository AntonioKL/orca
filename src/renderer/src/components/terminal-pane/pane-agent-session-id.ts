import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

export type PaneAgentSessionIdState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
}

/** Resolves the provider session owned by one exact terminal pane. */
export function resolvePaneAgentSessionId(
  state: PaneAgentSessionIdState,
  paneKey: string
): string | null {
  const live = state.agentStatusByPaneKey[paneKey]
  if (live && live.restoredUnconfirmed !== true) {
    return live.providerSession?.id ?? null
  }
  return state.sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id ?? null
}
