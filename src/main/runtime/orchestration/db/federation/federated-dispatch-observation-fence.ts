import type { OrchestrationDb } from '../orchestration-db'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction
} from '../lifecycle-transition'

export type FederatedDispatchObservationFence = {
  dispatch_id: string
  remote_runtime_epoch: string | null
  remote_worktree_id: string | null
  remote_terminal_handle: string | null
  dispatch_status: string
  task_status: string
  worker_runtime_epoch: string | null
  worker_state: string
  worker_stage: string
  worker_worktree_id: string | null
  worker_terminal_handle: string | null
  worker_setup_state: string
  worker_effects: string
  worker_residual_resources: string
  worker_last_error: string | null
}

export function captureFederatedDispatchObservationFence(
  this: OrchestrationDb,
  dispatchId: string
): FederatedDispatchObservationFence | undefined {
  return this.db
    .prepare(
      `SELECT fd.dispatch_id, fd.remote_runtime_epoch, fd.remote_worktree_id,
              fd.remote_terminal_handle, dc.status AS dispatch_status,
              t.status AS task_status, wd.runtime_epoch AS worker_runtime_epoch,
              wd.state AS worker_state, wd.stage AS worker_stage,
              wd.worktree_id AS worker_worktree_id,
              wd.agent_terminal_handle AS worker_terminal_handle,
              wd.setup_state AS worker_setup_state, wd.effects AS worker_effects,
              wd.residual_resources AS worker_residual_resources,
              wd.last_error AS worker_last_error
       FROM federated_dispatches fd
       INNER JOIN dispatch_contexts dc ON dc.id = fd.dispatch_id
       INNER JOIN tasks t ON t.id = dc.task_id
       INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
       WHERE fd.dispatch_id = ?`
    )
    .get(dispatchId) as FederatedDispatchObservationFence | undefined
}

export function projectFederatedDispatchObservation(
  this: OrchestrationDb,
  fence: FederatedDispatchObservationFence,
  projection: () => void
): boolean {
  const transaction = beginLifecycleWriteTransaction(this.db, 'federated_dispatch_observation')
  try {
    const current = this.captureFederatedDispatchObservationFence(fence.dispatch_id)
    if (!current || !observationFenceMatches(current, fence)) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return false
    }
    projection()
    commitLifecycleWriteTransaction(this.db, transaction)
    return true
  } catch (error) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw error
  }
}

function observationFenceMatches(
  current: FederatedDispatchObservationFence,
  expected: FederatedDispatchObservationFence
): boolean {
  return Object.keys(expected).every(
    (key) =>
      current[key as keyof FederatedDispatchObservationFence] ===
      expected[key as keyof FederatedDispatchObservationFence]
  )
}

export type FederatedDispatchObservationFenceMethods = {
  captureFederatedDispatchObservationFence: typeof captureFederatedDispatchObservationFence
  projectFederatedDispatchObservation: typeof projectFederatedDispatchObservation
}

export function attachFederatedDispatchObservationFence(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    captureFederatedDispatchObservationFence,
    projectFederatedDispatchObservation
  })
}
