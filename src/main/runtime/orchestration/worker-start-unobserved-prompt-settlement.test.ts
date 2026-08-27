import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime_test:term_worker:1'
let db: OrchestrationDb

function startWorker(spec: string): { taskId: string; dispatchId: string; capability: string } {
  const task = db.createTask({ spec })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  const capability = db.mintDispatchCapability({
    dispatchId: started.dispatch.id,
    paneKey: WORKER_PANE_KEY,
    processIncarnation: INCARNATION
  })
  return { taskId: task.id, dispatchId: started.dispatch.id, capability }
}

function verify(dispatchId: string, capability: string): { valid: boolean; reason?: string } {
  return db.verifyDispatchCapability({
    dispatchId,
    capability,
    paneKey: WORKER_PANE_KEY,
    processIncarnation: INCARNATION
  })
}

describe('worker start settled by an unobserved prompt', () => {
  afterEach(() => db?.close())

  it('keeps the capability and lets the worker report correct the record', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId, capability } = startWorker('run to completion')

    db.failWorkerStart(dispatchId, 'dispatch_input', 'agent_prompt_stalled', {
      retainCapability: true
    })

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'agent_prompt_stalled',
      capability_revoked_at: null
    })
    expect(verify(dispatchId, capability)).toEqual({ valid: true })

    expect(
      db.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'done the work'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    expect(db.getTask(taskId)).toMatchObject({ status: 'completed', result: 'done the work' })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({ state: 'succeeded', stage: 'settled' })
    expect(db.getLifecycleTransitionReceipts('task', taskId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'failed',
          to_state: 'completed',
          kind: 'task_prompt_stall_corrected'
        })
      ])
    )
    expect(db.getLifecycleTransitionReceipts('dispatch', dispatchId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'failed',
          to_state: 'completed',
          kind: 'dispatch_prompt_stall_corrected'
        })
      ])
    )
    expect(db.getLifecycleTransitionReceipts('worker', dispatchId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'failed',
          to_state: 'succeeded',
          kind: 'worker_prompt_stall_corrected'
        })
      ])
    )
  })

  it('revokes and stays settled when the start failed for any other cause', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId, capability } = startWorker('never became ready')

    db.failWorkerStart(dispatchId, 'agent_readiness', 'Agent did not become ready (idle).')

    expect(db.getDispatchContextById(dispatchId)?.capability_revoked_at).toEqual(expect.any(String))
    expect(verify(dispatchId, capability).valid).toBe(false)
    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(db.getTask(taskId)?.status).toBe('failed')
  })

  it('lets a failure report replace the unobserved-prompt cause with the real one', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId } = startWorker('reports its own failure')

    db.failWorkerStart(dispatchId, 'dispatch_input', 'agent_prompt_stalled', {
      retainCapability: true
    })

    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'failed', result: 'build broke on X' })
    ).toEqual({ action: 'settled', outcome: 'failed', duplicate: false })
    expect(db.getTask(taskId)).toMatchObject({ status: 'failed', result: 'build broke on X' })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'build broke on X'
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({ state: 'failed', stage: 'settled' })
    expect(db.getLifecycleTransitionReceipts('task', taskId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'failed',
          to_state: 'failed',
          kind: 'task_prompt_stall_corrected'
        })
      ])
    )
    expect(db.getLifecycleTransitionReceipts('dispatch', dispatchId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'failed',
          to_state: 'failed',
          kind: 'dispatch_prompt_stall_corrected'
        })
      ])
    )
    expect(db.getLifecycleTransitionReceipts('worker', dispatchId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'failed',
          to_state: 'failed',
          kind: 'worker_prompt_stall_corrected'
        })
      ])
    )

    // The stalled cause is gone, so a repeat report has nothing left to correct.
    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'failed', result: 'again' })
    ).toEqual({ action: 'settled', outcome: 'failed', duplicate: true })
    expect(db.getTask(taskId)?.result).toBe('build broke on X')
  })

  it('rolls back every prompt-stall correction when a receipt cannot be inserted', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId } = startWorker('atomic correction')
    db.failWorkerStart(dispatchId, 'dispatch_input', 'agent_prompt_stalled', {
      retainCapability: true
    })
    db.db.exec(`
      CREATE TRIGGER reject_worker_prompt_stall_correction
      BEFORE INSERT ON lifecycle_transition_receipts
      WHEN NEW.kind = 'worker_prompt_stall_corrected'
      BEGIN SELECT RAISE(ABORT, 'forced prompt-stall receipt failure'); END;
    `)

    expect(() =>
      db.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'uncommitted result'
      })
    ).toThrow('forced prompt-stall receipt failure')
    expect(db.getTask(taskId)).toMatchObject({ status: 'failed', result: null })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'agent_prompt_stalled',
      capability_revoked_at: null
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'dispatch_input'
    })
    expect(
      db
        .getLifecycleTransitionReceipts('task', taskId)
        .some((receipt) => receipt.kind === 'task_prompt_stall_corrected')
    ).toBe(false)
    expect(
      db
        .getLifecycleTransitionReceipts('dispatch', dispatchId)
        .some((receipt) => receipt.kind === 'dispatch_prompt_stall_corrected')
    ).toBe(false)
  })
})
