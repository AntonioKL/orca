import { projectAttemptOutcome } from '../attempt-outcome-projection'
import {
  exposeAttemptObservationFact,
  type AttemptObservationStorageRow
} from '../attempt-observation-store'
import type { AttemptProjectedOutcome } from '../attempt-observation-types'
import type { DispatchStatus, WorkerDispatchState } from '../../types'
import type { TerminalExitCause } from '../../../../../shared/terminal-exit-cause'
import type { OrchestrationDb } from '../orchestration-db'

export type WorkerAttentionFacts = {
  outcome: AttemptProjectedOutcome
  pendingInput: boolean
  pendingGuidance: boolean
  pendingApproval: boolean
  terminationReason: TerminalExitCause['kind'] | null
  isRoot: boolean
  workerState: WorkerDispatchState | null
  dispatchStatus: DispatchStatus
}

export function getWorkerAttentionFactsForDispatches(
  this: OrchestrationDb,
  dispatchIds: readonly string[],
  authorityNow: number
): Map<string, WorkerAttentionFacts> {
  const ids = [...new Set(dispatchIds)]
  if (ids.length === 0) {
    return new Map()
  }
  const serializedIds = JSON.stringify(ids)
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id, d.task_id, d.status AS dispatch_status,
              d.termination_reason, w.state AS worker_state, t.parent_id AS parent_task_id,
              EXISTS (
                SELECT 1 FROM question_threads q
                 WHERE q.dispatch_id = d.id AND q.status = 'pending'
              ) AS pending_input,
              EXISTS (
                SELECT 1 FROM decision_gates g
                 WHERE g.task_id = d.task_id AND g.status = 'pending'
              ) AS pending_approval,
              EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.run_id = d.run_id AND m.to_handle = 'dispatch:' || d.id
                   AND m.read = 0 AND m.delivery_contract = 'current_delivery'
              ) AS pending_guidance,
              EXISTS (
                SELECT 1 FROM dispatch_contexts active
                JOIN worker_dispatches sibling_worker ON sibling_worker.dispatch_id = active.id
                WHERE active.task_id = d.task_id AND active.id != d.id
                  AND active.status IN ('pending', 'dispatched')
                  AND sibling_worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
              ) AS active_sibling
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN tasks t ON t.id = d.task_id AND t.run_id = d.run_id
        WHERE d.id IN (SELECT value FROM json_each(?))`
    )
    .all(serializedIds) as {
    dispatch_id: string
    task_id: string
    dispatch_status: DispatchStatus
    termination_reason: TerminalExitCause['kind'] | null
    worker_state: WorkerDispatchState | null
    parent_task_id: string | null
    pending_input: number
    pending_approval: number
    pending_guidance: number
    active_sibling: number
  }[]
  const observationRows = this.db
    .prepare(
      `SELECT * FROM attempt_observation_facts
        WHERE dispatch_id IN (SELECT value FROM json_each(?))
        ORDER BY dispatch_id, sequence, rowid`
    )
    .all(serializedIds) as AttemptObservationStorageRow[]
  const factsByDispatch = new Map<string, ReturnType<typeof exposeAttemptObservationFact>[]>()
  for (const observationRow of observationRows) {
    const facts = factsByDispatch.get(observationRow.dispatch_id) ?? []
    facts.push(exposeAttemptObservationFact(observationRow))
    factsByDispatch.set(observationRow.dispatch_id, facts)
  }
  return new Map(
    rows.map((row) => {
      const projected = projectAttemptOutcome({
        dispatchId: row.dispatch_id,
        taskId: row.task_id,
        facts: factsByDispatch.get(row.dispatch_id) ?? [],
        activeSibling: row.active_sibling === 1,
        authorityNow: { home: authorityNow }
      }).taskOutcome
      return [
        row.dispatch_id,
        {
          outcome: projected,
          pendingInput: row.pending_input === 1,
          pendingGuidance: row.pending_guidance === 1,
          pendingApproval: row.pending_approval === 1,
          terminationReason: row.termination_reason,
          isRoot: row.parent_task_id === null,
          workerState: row.worker_state,
          dispatchStatus: row.dispatch_status
        }
      ]
    })
  )
}

export function getWorkerAttentionFacts(
  this: OrchestrationDb,
  dispatchId: string,
  authorityNow: number
): WorkerAttentionFacts {
  const facts = this.getWorkerAttentionFactsForDispatches([dispatchId], authorityNow).get(
    dispatchId
  )
  if (!facts) {
    throw new Error(`Dispatch ${dispatchId} was not found.`)
  }
  return facts
}
