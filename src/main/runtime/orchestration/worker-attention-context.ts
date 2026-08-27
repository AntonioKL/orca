import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { projectOrchestrationFleetAttention } from '../../../shared/orchestration-fleet-attention'
import type { OrchestrationDb } from './db'
import type { WorkerAttentionFacts } from './db/worker-terminal/worker-terminal-attention-query'
import type { DispatchContextRow, TaskRow } from './types'

function statusLiveness(
  status: AgentStatusIpcPayload | undefined,
  now: number
): { verdict: 'live' | 'unverifiable'; reason?: string } {
  if (!status || status.restoredUnconfirmed || status.providerSessionOnly) {
    return { verdict: 'unverifiable', reason: 'missing_status' }
  }
  if (status.receivedAt > now + 5_000) {
    return { verdict: 'unverifiable', reason: 'future_status' }
  }
  if (now - status.receivedAt > AGENT_STATUS_STALE_AFTER_MS) {
    return { verdict: 'unverifiable', reason: 'stale_status' }
  }
  return { verdict: 'live' }
}

function resolvedOutcome(facts: WorkerAttentionFacts): WorkerAttentionFacts['outcome'] {
  if (facts.outcome !== 'outcome_unknown') {
    return facts.outcome
  }
  if (facts.workerState === 'succeeded' || facts.workerState === 'failed') {
    return facts.workerState
  }
  return facts.dispatchStatus === 'pending' || facts.dispatchStatus === 'dispatched'
    ? 'in_progress'
    : facts.outcome
}

export function buildWorkerAttentionContext(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  task: TaskRow | undefined
  status: AgentStatusIpcPayload | undefined
  now?: number
}) {
  const now = args.now ?? Date.now()
  const facts = args.db.getWorkerAttentionFacts(args.dispatch.id, now)
  return projectWorkerAttentionContext({
    facts,
    isRoot: args.task?.parent_id == null,
    status: args.status,
    now
  })
}

export function projectWorkerAttentionContext(args: {
  facts: WorkerAttentionFacts
  isRoot: boolean
  status: AgentStatusIpcPayload | undefined
  now: number
}) {
  return projectOrchestrationFleetAttention({
    isRoot: args.isRoot,
    outcome: resolvedOutcome(args.facts),
    pendingInput: args.facts.pendingInput,
    pendingGuidance: args.facts.pendingGuidance,
    pendingApproval: args.facts.pendingApproval,
    interrupted:
      args.facts.terminationReason === 'operator_close' ||
      args.facts.terminationReason === 'signaled',
    liveness: statusLiveness(args.status, args.now)
  })
}
