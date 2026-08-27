import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { createRootDispatch } from './root-dispatch-test-fixture'

describe('decision-gate lifecycle transitions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('records the guarded Task transition when creating a gate', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'gate receipt' })
    createRootDispatch(db, task.id, 'term_gate')

    db.createGate({ taskId: task.id, question: 'Proceed?' })

    expect(db.getLifecycleTransitionReceipts('task', task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_state: 'dispatched',
          to_state: 'blocked',
          kind: 'task_gate_created'
        })
      ])
    )
  })

  it('rolls back gate and dispatch projections when receipt append fails', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'atomic gate creation' })
    const dispatch = createRootDispatch(db, task.id, 'term_gate')
    const taskReceiptsBefore = db.getLifecycleTransitionReceipts('task', task.id)
    db.db.exec(`
      CREATE TRIGGER reject_gate_lifecycle_receipt
      BEFORE INSERT ON lifecycle_transition_receipts
      WHEN NEW.kind = 'task_gate_created'
      BEGIN SELECT RAISE(ABORT, 'forced gate receipt failure'); END;
    `)

    expect(() => db!.createGate({ taskId: task.id, question: 'Proceed?' })).toThrow(
      'forced gate receipt failure'
    )
    expect(db.listGates({ taskId: task.id })).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(db.getLifecycleTransitionReceipts('task', task.id)).toEqual(taskReceiptsBefore)
  })
})
