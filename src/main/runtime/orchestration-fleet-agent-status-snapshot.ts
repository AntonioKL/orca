import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import {
  mintAgentStatusFleetEvidence,
  type AgentStatusRuntimeEnrichment
} from '../ipc/agent-status-ipc-boundary'

/** The runtime facts the fleet snapshot needs: the hook rows, and the pane identity lookups
 *  the terminal registry owns. */
export type FleetAgentStatusSnapshotSource = AgentStatusRuntimeEnrichment & {
  getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null
}

/**
 * Push-fed hook rows minted into fleet evidence. Callers must redact payload text.
 *
 * Extracted from the `@ts-nocheck` runtime mixin so the minting is type-checked: hook rows carry
 * only a pane key, and it was this hop publishing pane identity into a matcher that compares
 * terminal identity that made every local worker read `missing_status` while it was running.
 */
export function readOrchestrationFleetAgentStatusSnapshot(
  runtime: FleetAgentStatusSnapshotSource
): readonly FleetAgentStatusEvidence[] {
  return (runtime.getAgentStatusSnapshotFn?.() ?? []).map((entry) =>
    mintAgentStatusFleetEvidence(entry, runtime)
  )
}
