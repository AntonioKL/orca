import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker
} from '../../../../shared/orchestration-fleet-projection'
import type { WorkerTerminalListState } from '../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../orchestration/db'

export type WorkerListPageParams = {
  run?: string
  terminalState?: WorkerTerminalListState
  includeRemote?: boolean
  paginate?: boolean
}

export function projectWorkerFleet(args: {
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>
  attentionFacts: ReturnType<OrchestrationDb['getWorkerAttentionFactsForDispatches']>
  statuses: Parameters<typeof projectOrchestrationFleet>[0]['statuses']
  limit: number
  now: number
  completeProjection?: boolean
}) {
  const workers: FleetDurableWorker[] = args.rows.map((row) => {
    const outcome = args.attentionFacts.get(row.dispatchId)?.outcome ?? 'outcome_unknown'
    return {
      ...row,
      outcome:
        outcome === 'outcome_unknown'
          ? row.workerState === 'succeeded'
            ? 'succeeded'
            : row.workerState === 'failed'
              ? 'failed'
              : row.dispatchStatus === 'pending' || row.dispatchStatus === 'dispatched'
                ? 'in_progress'
                : outcome
          : outcome,
      resource: row.resource
        ? {
            id: row.resource.id,
            ownerDispatchId: row.resource.owner_dispatch_id,
            worktreeId: row.resource.worktree_id,
            paneKey: row.resource.pane_key,
            processIncarnation: row.resource.process_incarnation,
            endpointId: row.resource.endpoint_id,
            endpointIncarnation: row.resource.endpoint_incarnation,
            hostScope: row.resource.host_scope,
            ownershipState: row.resource.ownership_state,
            releaseState: row.resource.release_state,
            updatedAt: row.resource.updated_at
          }
        : null
    }
  })
  if (!args.completeProjection) {
    return projectOrchestrationFleet({
      workers,
      statuses: args.statuses,
      limit: args.limit,
      now: args.now
    })
  }

  const projections: ReturnType<typeof projectOrchestrationFleet>['workers'] = []
  for (let offset = 0; offset < workers.length; offset += ORCHESTRATION_FLEET_PAGE_MAX) {
    projections.push(
      ...projectOrchestrationFleet({
        workers: workers.slice(offset, offset + ORCHESTRATION_FLEET_PAGE_MAX),
        statuses: args.statuses,
        limit: ORCHESTRATION_FLEET_PAGE_MAX,
        now: args.now
      }).workers
    )
  }
  return {
    workers: projections,
    page: { limit: workers.length, total: workers.length, hasMore: false, nextCursor: null }
  }
}
