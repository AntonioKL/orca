import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import {
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  seedCodexStateFromSnapshot
} from '../shared/agent-hook-listener/providers/codex-state'
import { codexRosterToSnapshots } from '../shared/codex-subagent-roster'
import { reconcileCodexSubagentTranscript } from '../shared/codex-subagent-transcript'
import { seedCodexSubagentTranscriptFromSnapshot } from '../shared/codex-subagent-transcript-seeding'
import { createRelayCodexReconciler, type RelayHookStatusMeta } from './agent-hook-status-cache'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

export function createRelayCodexReconciliationSchedulers(options: {
  state: HookListenerState
  isListening: () => boolean
  timers: Map<string, ReturnType<typeof setTimeout>>
  metadata: ReadonlyMap<string, RelayHookStatusMeta>
  forward: (envelope: AgentHookRelayEnvelope) => void
  persist: () => void
  gate: { nextRunAt: number }
}): { live: (paneKey: string) => void; restart: (paneKey: string) => void } {
  return {
    live: createRelayCodexReconciler({
      ...options,
      reconcile: (event) => reconcileRelayCodexEvent(options.state, event)
    }),
    restart: createRelayCodexReconciler({
      ...options,
      isReplay: true,
      reconcile: (event) =>
        reconcileRelayCodexEvent(options.state, event, { reconcileParentState: true })
    })
  }
}

export function reconcileRelayCodexEvent(
  state: HookListenerState,
  event: AgentHookEventPayload,
  options: { reconcileParentState?: boolean } = {}
): AgentHookEventPayload {
  const transcriptPath = event.providerSession?.transcriptPath
  if (!transcriptPath || event.payload.agentType !== 'codex') {
    return event
  }
  seedCodexStateFromSnapshot(state, event.paneKey, event.payload)
  const transcript = getOrCreateCodexSubagentTranscriptState(state, event.paneKey)
  if (event.payload.subagents?.length) {
    seedCodexSubagentTranscriptFromSnapshot(transcript, event.payload.subagents, transcriptPath)
  }
  const roster = getOrCreateCodexSubagentRoster(state, event.paneKey)
  reconcileCodexSubagentTranscript(transcript, roster, transcriptPath)
  const subagents = codexRosterToSnapshots(roster)
  const payload = {
    ...event.payload,
    ...(subagents ? { subagents } : { subagents: undefined }),
    ...(options.reconcileParentState
      ? transcript.parentTerminalObserved === true
        ? { state: 'done' as const }
        : transcript.parentTerminalObserved === false
          ? {
              state: event.payload.state === 'waiting' ? ('waiting' as const) : ('working' as const)
            }
          : {}
      : {})
  }
  const transcriptUnreadable =
    transcript.parentReadable === false ||
    [...transcript.subagents.values()].some((child) => child.unresolvedSince)
  return transcriptUnreadable
    ? { ...event, payload }
    : event.reconcileDiagnostic?.reason === 'transcript-unreadable'
      ? { ...event, payload, reconcileDiagnostic: null }
      : { ...event, payload }
}
