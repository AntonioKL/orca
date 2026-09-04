import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { projectOrchestrationFleetAttention } from '../../../shared/orchestration-fleet-attention'
import { projectLiveness } from '../../../shared/orchestration-fleet-worker-projection'
import type { OrchestrationDb } from './db'
import type { WorkerAttentionFacts } from './db/worker-terminal/worker-terminal-attention-query'
import type { DispatchContextRow, TaskRow } from './types'

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
    isRoot: facts.isRoot,
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
    liveness: projectLiveness(
      {
        workerState: args.facts.workerState,
        workerStage: args.facts.workerStage,
        terminationReason: args.facts.terminationReason,
        resource:
          args.facts.hostScope === undefined
            ? null
            : { hostScope: args.facts.hostScope, releaseState: args.facts.releaseState }
      },
      args.status,
      args.now
    )
  })
}
