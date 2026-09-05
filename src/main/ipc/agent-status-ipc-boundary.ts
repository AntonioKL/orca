import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  mintFleetAgentStatusEvidence,
  type FleetAgentStatusEvidence,
  type FleetEvidenceBinding
} from '../../shared/orchestration-fleet-agent-status-evidence'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type AgentStatusRuntimeEnrichment = Pick<
  OrcaRuntimeService,
  | 'getAgentStatusTerminalHandleForPaneKey'
  | 'getAgentStatusOrchestrationContextForPaneKey'
  | 'getTerminalProcessIncarnation'
>

const MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH = 160

/** The one place a pane key becomes terminal identity. Both the IPC payload the renderer
 *  decodes and the fleet evidence the orchestration path reads are derived from this. */
export function resolveAgentStatusBinding(
  paneKey: string,
  runtime: AgentStatusRuntimeEnrichment | undefined
): FleetEvidenceBinding {
  const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
  if (!terminalHandle) {
    return { kind: 'unresolved', reason: 'pane_not_bound' }
  }
  const processIncarnation = runtime?.getTerminalProcessIncarnation(terminalHandle)
  if (!processIncarnation) {
    return { kind: 'unresolved', reason: 'incarnation_unbound' }
  }
  const dispatchId = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)?.dispatchId
  return dispatchId
    ? { kind: 'worker', dispatchId, terminalHandle, paneKey, processIncarnation }
    : { kind: 'pane', terminalHandle, paneKey, processIncarnation }
}

export function mintAgentStatusFleetEvidence(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): FleetAgentStatusEvidence {
  return mintFleetAgentStatusEvidence(data, resolveAgentStatusBinding(data.paneKey, runtime))
}

/** Unchanged wire shape: `agentStatus:set` and `agentStatus:getSnapshot` still publish the
 *  same optional fields an older renderer decodes. Only the identity lookup is shared. */
export function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    return data
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  return {
    ...data,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }
}

export function isValidAgentStatusDropTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH &&
    value.trim() === value &&
    isValidTerminalTabId(value)
  )
}
