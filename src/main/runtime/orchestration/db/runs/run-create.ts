import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    /** The active worker Dispatch that created this sub-Run, if any. */
    parentDispatchId?: string
  }
): RunRow {
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Re-check inside the write transaction so a completed/revoked Dispatch is never
    // recorded as the origin of a Run after its lifecycle authority has ended.
    const parentDispatchId = params.parentDispatchId
      ? ((
          this.db
            .prepare(
              `SELECT id FROM dispatch_contexts
             WHERE id = ? AND status IN ('pending', 'dispatched')`
            )
            .get(params.parentDispatchId) as { id: string } | undefined
        )?.id ?? null)
      : null
    this.unbindOtherRunsForPane(params.coordinatorPaneKey)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key,
           parent_dispatch_id, consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 0)`
      )
      .run(
        id,
        params.objective,
        params.coordinatorHandle,
        params.coordinatorPaneKey,
        parentDispatchId
      )
    this.rememberRunCoordinatorHandle(id, params.coordinatorHandle)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
