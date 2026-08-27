import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { projectOrchestrationFleetAttention } from './orchestration-fleet-attention'
import type {
  FleetDurableWorker,
  FleetLiveness,
  FleetNextAction,
  FleetResourceProjection,
  OrchestrationFleetWorker
} from './orchestration-fleet-projection'

const FLEET_STATUS_FUTURE_TOLERANCE_MS = 5_000

function projectLiveness(
  worker: FleetDurableWorker,
  status: AgentStatusIpcPayload | undefined,
  now: number
): FleetLiveness {
  // A federated release is an execution-host confirmation that the terminal
  // is gone. The worker outcome remains independent of this cleanup fact.
  if (worker.workerStage === 'released') {
    return { verdict: 'exited', source: 'execution_host' }
  }
  if (worker.resource?.releaseState === 'released') {
    return { verdict: 'exited', source: 'resource_release' }
  }
  if (worker.workerState === 'stopped') {
    return { verdict: 'exited', source: 'worker_stop' }
  }
  if (!status) {
    return { verdict: 'unverifiable', reason: 'missing_status' }
  }
  if (status.restoredUnconfirmed) {
    return {
      verdict: 'unverifiable',
      reason: 'restored_unconfirmed',
      observedAt: status.receivedAt
    }
  }
  if (status.providerSessionOnly) {
    return { verdict: 'unverifiable', reason: 'missing_status', observedAt: status.receivedAt }
  }
  if (status.receivedAt - now > FLEET_STATUS_FUTURE_TOLERANCE_MS) {
    return { verdict: 'unverifiable', reason: 'future_status', observedAt: status.receivedAt }
  }
  const remoteHost = projectHost(status, worker.resource?.hostScope).kind === 'remote'
  if (remoteHost && !status.connectionId) {
    return { verdict: 'unverifiable', reason: 'missing_status', observedAt: status.receivedAt }
  }
  if (now - status.receivedAt > AGENT_STATUS_STALE_AFTER_MS) {
    return { verdict: 'unverifiable', reason: 'stale_status', observedAt: status.receivedAt }
  }
  return { verdict: 'live', observedAt: status.receivedAt, source: 'agent_status' }
}

function projectResource(worker: FleetDurableWorker): FleetResourceProjection {
  const resource = worker.resource
  if (!resource) {
    return {
      state: 'absent',
      reason: worker.workerState === 'unsupervised' ? 'unsupervised' : 'not_materialized'
    }
  }
  const state = ['owned', 'transferred', 'user_owned', 'external', 'released'].includes(
    resource.ownershipState
  )
    ? (resource.ownershipState as Exclude<FleetResourceProjection['state'], 'absent'>)
    : 'external'
  return {
    state,
    id: resource.id,
    ownerDispatchId: resource.ownerDispatchId,
    releaseState: resource.releaseState,
    terminalState: worker.terminalState
  }
}

function nextAction(worker: FleetDurableWorker): FleetNextAction {
  if (worker.workerStage === 'released') {
    return { kind: 'none', argv: [] }
  }
  if (worker.terminalState === 'reclaimable') {
    return {
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
    }
  }
  if (
    worker.terminalState === 'released' ||
    (worker.dispatchStatus === 'completed' && !worker.agentTerminalHandle)
  ) {
    return { kind: 'none', argv: [] }
  }
  return {
    kind: 'inspect',
    argv: ['orchestration', 'worker-show', '--dispatch', worker.dispatchId]
  }
}

function projectHost(
  status: AgentStatusIpcPayload | undefined,
  hostScope: string | null | undefined
): OrchestrationFleetWorker['host'] {
  if (status?.connectionId) {
    return { kind: 'remote', id: status.connectionId }
  }
  if (!hostScope) {
    // A missing host scope is the legacy/default representation for local and
    // folder-workspace authority; do not infer a remote host from resource
    // materialization alone.
    return { kind: 'local', id: 'local' }
  }
  try {
    const parsed = JSON.parse(hostScope) as {
      kind?: unknown
      hostId?: unknown
      targetId?: unknown
    }
    if (parsed.kind === 'local') {
      return { kind: 'local', id: typeof parsed.hostId === 'string' ? parsed.hostId : 'local' }
    }
    if (typeof parsed.kind === 'string') {
      const id =
        typeof parsed.targetId === 'string'
          ? parsed.targetId
          : typeof parsed.hostId === 'string'
            ? parsed.hostId
            : parsed.kind
      return { kind: 'remote', id }
    }
  } catch {
    if (hostScope.startsWith('local:')) {
      return { kind: 'local', id: 'local' }
    }
  }
  return { kind: 'remote', id: 'unknown' }
}

export function projectOrchestrationFleetWorker(
  worker: FleetDurableWorker,
  status: AgentStatusIpcPayload | undefined,
  now: number
): OrchestrationFleetWorker {
  const liveness = projectLiveness(worker, status, now)
  const fresh = liveness.verdict === 'live'
  const workspaceId = status?.worktreeId ?? worker.worktreeId ?? worker.resource?.worktreeId ?? null
  const outcome =
    worker.outcome ??
    (worker.workerState === 'succeeded'
      ? 'succeeded'
      : worker.workerState === 'failed' || worker.dispatchStatus === 'failed'
        ? 'failed'
        : 'in_progress')
  return {
    id: worker.dispatchId,
    dispatchId: worker.dispatchId,
    taskId: worker.taskId,
    runId: worker.runId,
    role: 'worker',
    parent: worker.parentTaskId ? { taskId: worker.parentTaskId } : null,
    provider: status?.agentType ? { id: status.agentType, model: status.model ?? null } : null,
    host: projectHost(status, worker.resource?.hostScope),
    workspace: workspaceId ? { id: workspaceId, kind: 'folder_or_worktree' } : null,
    stage: {
      worker: worker.workerState,
      dispatch: worker.dispatchStatus,
      detail: worker.workerStage,
      activity: fresh && status ? status.state : 'unknown'
    },
    liveness,
    evidence: {
      durable: true,
      liveStatus: !status
        ? 'unavailable'
        : status.restoredUnconfirmed
          ? 'redacted_restore'
          : fresh
            ? 'fresh'
            : 'stale',
      lastObservedAt: status?.receivedAt ?? null
    },
    resource: projectResource(worker),
    nextAction: nextAction(worker),
    attention: projectOrchestrationFleetAttention({
      isRoot: worker.parentTaskId === null,
      outcome,
      pendingInput: worker.pendingInput,
      pendingApproval: worker.pendingApproval,
      interrupted:
        worker.workerState === 'abandoned' ||
        worker.terminationReason === 'operator_close' ||
        worker.terminationReason === 'signaled',
      liveness
    })
  }
}
