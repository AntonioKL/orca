import type { AgentSessionStoreState } from './agent-session-record-store-file'

export function serializeAgentSessionStoreState(state: AgentSessionStoreState): string {
  const records: Record<string, unknown> = Object.create(null)
  for (const [sessionId, record] of state.records) {
    records[sessionId] = record
  }
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    hostId: state.hostId,
    records,
    operations: Object.fromEntries(state.operations),
    retiredClaimKeys: state.retiredClaimKeys,
    unusableRecords: Object.fromEntries(state.unreadableRecords),
    visibleSessionIds: [...state.visibleSessionIds]
  })
}
