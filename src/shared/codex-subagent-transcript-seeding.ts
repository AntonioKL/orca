import type { AgentSubagentSnapshot } from './agent-status-types'
import type { CodexSubagentTranscriptState } from './codex-subagent-transcript'

const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

export function seedCodexSubagentTranscriptFromSnapshot(
  state: CodexSubagentTranscriptState,
  snapshots: readonly Pick<AgentSubagentSnapshot, 'id' | 'description' | 'startedAt' | 'model'>[]
): void {
  for (const snapshot of snapshots) {
    if (!SAFE_THREAD_ID.test(snapshot.id) || state.subagents.has(snapshot.id)) {
      continue
    }
    state.subagents.set(snapshot.id, {
      offset: 0,
      carry: '',
      description: snapshot.description,
      model: snapshot.model,
      startedAt: Number.isFinite(snapshot.startedAt) ? snapshot.startedAt : Date.now()
    })
  }
}
