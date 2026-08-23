import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'

type ResumeRetirementStore = {
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
}

export function retireConfirmedAgentExitResumeRecord(
  state: ResumeRetirementStore,
  consumed: { paneKey: string; record: SleepingAgentSessionRecord }
): void {
  const paneKeys = [consumed.paneKey]
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
    if (
      paneKey !== consumed.paneKey &&
      record.worktreeId === consumed.record.worktreeId &&
      record.agent === consumed.record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        record.providerSession,
        consumed.record.providerSession
      )
    ) {
      paneKeys.push(paneKey)
    }
  }
  state.clearSleepingAgentSessionsByPaneKey(paneKeys)
}

export function retireConfirmedAgentExitResumeAuthority(
  state: ResumeRetirementStore,
  paneKey: string
): void {
  const record = state.sleepingAgentSessionsByPaneKey[paneKey]
  if (!record) {
    return
  }
  retireConfirmedAgentExitResumeRecord(state, { paneKey, record })
}
