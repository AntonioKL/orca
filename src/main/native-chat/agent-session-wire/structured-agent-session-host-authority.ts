import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'

/** Transport state observed by the client while asking the execution host about a session. */
export type StructuredAgentSessionTransportState =
  | 'connected'
  | 'disconnected'
  | 'half-open'
  | 'reconnect-exhausted'

/** Host evidence needed to turn a structured-session observation into a verdict. */
export type StructuredAgentSessionHostObservation = {
  transport: StructuredAgentSessionTransportState
  owner: AgentSessionOwnerProbe
  journal: 'readable' | 'unreadable' | 'unknown'
}

/**
 * Resolve the execution-host verdict without allowing client transport state to become death
 * evidence. A disconnected/half-open host remains unverifiable; only a connected host's
 * PID-reuse-safe probe can produce live or exited.
 */
export function resolveStructuredAgentSessionHostVerdict(
  observation: StructuredAgentSessionHostObservation
): PtyLivenessVerdict['status'] {
  if (observation.transport !== 'connected' || observation.journal !== 'readable') {
    return 'unverifiable'
  }
  if (isProvenDeadProbe(observation.owner)) {
    return 'exited'
  }
  if (isProvenAliveProbe(observation.owner)) {
    return 'live'
  }
  return 'unverifiable'
}
