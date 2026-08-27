import type { WorkerTerminalListState } from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerTerminalListingSnapshot } from './worker-terminal-listing'

export const WORKER_TERMINAL_STATE_EXPRESSION = `CASE
  WHEN r.id IS NULL THEN CASE WHEN COALESCE(w.agent_terminal_handle, d.assignee_handle) IS NOT NULL THEN 'retained' ELSE NULL END
  WHEN r.release_state = 'released' THEN 'released'
  WHEN r.release_state = 'unknown' THEN 'release_unknown'
  WHEN r.release_state IN ('requested', 'releasing') THEN 'release_pending'
  WHEN r.ownership_state <> 'owned' OR r.release_state = 'retained' THEN 'retained'
  WHEN COALESCE(w.state, 'unsupervised') <> 'unsupervised' AND COALESCE(w.state, '') IN ('succeeded', 'failed') THEN 'reclaimable'
  WHEN COALESCE(w.state, 'unsupervised') <> 'unsupervised' AND COALESCE(w.state, '') IN ('succeeded', 'failed', 'stopped', 'abandoned') THEN 'retained'
  WHEN COALESCE(w.state, 'unsupervised') <> 'unsupervised' THEN 'active'
  ELSE NULL
END`

type WorkerTerminalInventoryParams = {
  runId?: string
  snapshot?: WorkerTerminalListingSnapshot
  terminalState?: WorkerTerminalListState
}

function buildInventoryScope(params: WorkerTerminalInventoryParams): {
  where: string[]
  values: (string | number)[]
} {
  const orderExpression = 'COALESCE(w.created_at, d.created_at)'
  const where: string[] = []
  const values: (string | number)[] = []
  if (params.runId) {
    where.push('d.run_id = ?')
    values.push(params.runId)
  }
  if (params.snapshot) {
    if ('databaseId' in params.snapshot) {
      where.push('d.rowid <= ?')
      values.push(params.snapshot.databaseId)
    } else {
      where.push(`(${orderExpression} < ? OR (${orderExpression} = ? AND d.id <= ?))`)
      values.push(params.snapshot.createdAt, params.snapshot.createdAt, params.snapshot.dispatchId)
    }
  }
  return { where, values }
}

export function countWorkerTerminalResources(
  this: OrchestrationDb,
  params: WorkerTerminalInventoryParams = {}
): number {
  const { where, values } = buildInventoryScope(params)
  if (params.terminalState) {
    where.push(`${WORKER_TERMINAL_STATE_EXPRESSION} = ?`)
    values.push(params.terminalState)
  }
  const row = this.db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`
    )
    .get(...values) as { count: number }
  return Number(row.count)
}

export function countWorkerTerminalInventory(
  this: OrchestrationDb,
  params: WorkerTerminalInventoryParams = {}
): {
  total: number
  counts: Partial<Record<WorkerTerminalListState, number>>
} {
  const { where, values } = buildInventoryScope(params)
  const rows = this.db
    .prepare(
      `SELECT terminal_state, COUNT(*) AS count
         FROM (
           SELECT ${WORKER_TERMINAL_STATE_EXPRESSION} AS terminal_state
             FROM dispatch_contexts d
             LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
             LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
            ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ) inventory
        GROUP BY terminal_state`
    )
    .all(...values) as { terminal_state: WorkerTerminalListState | null; count: number }[]
  const counts: Partial<Record<WorkerTerminalListState, number>> = {}
  let total = 0
  for (const row of rows) {
    const count = Number(row.count)
    total += count
    if (row.terminal_state) {
      counts[row.terminal_state] = count
    }
  }
  return {
    total: params.terminalState ? (counts[params.terminalState] ?? 0) : total,
    counts
  }
}
