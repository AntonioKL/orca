import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { createFleetStatusIndex, statusForFleetWorker } from './orchestration-fleet-status-index'
import type {
  OrchestrationFleetAttention,
  OrchestrationFleetAttentionCategory
} from './orchestration-fleet-attention'
import { projectOrchestrationFleetWorker } from './orchestration-fleet-worker-projection'

export const ORCHESTRATION_FLEET_PAGE_MAX = 100

export type FleetTerminalState =
  | 'active'
  | 'reclaimable'
  | 'retained'
  | 'release_pending'
  | 'release_unknown'
  | 'released'

export type FleetDurableWorker = {
  dispatchId: string
  taskId: string
  runId: string
  parentTaskId: string | null
  workerState: string
  dispatchStatus: string
  workerStage: string | null
  agentTerminalHandle: string | null
  paneKey: string | null
  worktreeId: string | null
  terminalState: FleetTerminalState | null
  pendingInput?: boolean
  pendingApproval?: boolean
  terminationReason?: 'operator_close' | 'signaled' | 'exited' | 'unknown' | null
  outcome?: 'in_progress' | 'succeeded' | 'failed' | 'outcome_unknown' | 'finished_unverified'
  resource: {
    id: string
    ownerDispatchId: string
    worktreeId: string | null
    paneKey: string | null
    processIncarnation?: string | null
    endpointId?: string | null
    endpointIncarnation?: string | null
    hostScope: string | null
    ownershipState: string
    releaseState: string
    updatedAt: string
  } | null
}

export type FleetLiveness =
  | { verdict: 'live'; observedAt: number; source: 'agent_status' | 'execution_host' }
  | {
      verdict: 'unverifiable'
      reason:
        | 'missing_status'
        | 'stale_status'
        | 'future_status'
        | 'restored_unconfirmed'
        | 'host_unavailable'
      observedAt?: number
    }
  | { verdict: 'exited'; source: 'resource_release' | 'worker_stop' | 'execution_host' }

export type FleetResourceProjection =
  | {
      state: 'owned' | 'transferred' | 'user_owned' | 'external' | 'released'
      id: string
      ownerDispatchId: string
      releaseState: string
      terminalState: FleetTerminalState | null
    }
  | { state: 'absent'; reason: 'unsupervised' | 'not_materialized' }

export type FleetNextAction = {
  kind: 'inspect' | 'release' | 'none'
  argv: string[]
}

export type OrchestrationFleetWorker = {
  id: string
  dispatchId: string
  taskId: string
  runId: string
  role: 'worker'
  parent: { taskId: string } | null
  provider: { id: string; model: string | null } | null
  host: { kind: 'local' | 'remote'; id: string }
  workspace: { id: string; kind: 'folder_or_worktree' } | null
  stage: {
    worker: string
    dispatch: string
    detail: string | null
    activity: 'working' | 'blocked' | 'waiting' | 'done' | 'unknown'
  }
  liveness: FleetLiveness
  evidence: {
    durable: true
    liveStatus: 'fresh' | 'stale' | 'unavailable' | 'redacted_restore'
    lastObservedAt: number | null
  }
  resource: FleetResourceProjection
  nextAction: FleetNextAction
  attention: OrchestrationFleetAttention
}

export type OrchestrationFleetPage = {
  workers: OrchestrationFleetWorker[]
  page: {
    limit: number
    total: number
    hasMore: boolean
    nextCursor: string | null
  }
}

export function refreshOrchestrationFleetLivenessAttention(worker: OrchestrationFleetWorker): void {
  const categories: OrchestrationFleetAttentionCategory[] = worker.attention.categories.filter(
    (category) => category !== 'stale' && category !== 'unverifiable'
  )
  if (worker.liveness.verdict === 'unverifiable') {
    categories.push(worker.liveness.reason === 'stale_status' ? 'stale' : 'unverifiable')
  }
  worker.attention = {
    categories,
    requiresAction: categories.some((category) =>
      ['input', 'approval', 'failure', 'interruption', 'unverifiable'].includes(category)
    )
  }
}

export function projectOrchestrationFleet(args: {
  workers: readonly FleetDurableWorker[]
  statuses: readonly AgentStatusIpcPayload[]
  now?: number
  cursor?: string
  limit?: number
}): OrchestrationFleetPage {
  const limit = Math.min(
    ORCHESTRATION_FLEET_PAGE_MAX,
    Math.max(1, Math.floor(args.limit ?? ORCHESTRATION_FLEET_PAGE_MAX))
  )
  const cursorIndex = args.cursor
    ? args.workers.findIndex((worker) => worker.dispatchId === args.cursor)
    : -1
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
  const rows = args.workers.slice(start, start + limit)
  const statusIndex = createFleetStatusIndex(args.statuses, rows)
  const now = args.now ?? Date.now()
  const workers = rows.map((worker) =>
    projectOrchestrationFleetWorker(worker, statusForFleetWorker(worker, statusIndex), now)
  )
  const hasMore = start + workers.length < args.workers.length
  return {
    workers,
    page: {
      limit,
      total: args.workers.length,
      hasMore,
      nextCursor: hasMore ? (rows.at(-1)?.dispatchId ?? null) : null
    }
  }
}
