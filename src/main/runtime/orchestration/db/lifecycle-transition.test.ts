import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

describe('guarded lifecycle transitions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects a stale prior state without writing a receipt', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'guarded transition' })

    expect(() =>
      db!.transitionLifecycle({
        entity: 'task',
        id: task.id,
        from: 'pending',
        to: 'completed'
      })
    ).toThrow(/expected pending/)
    expect(db.getLifecycleTransitionReceipts('task', task.id)).toEqual([])
  })

  it('rolls back the legacy projection when receipt append fails', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'atomic receipt' })
    db.db.exec(`
      CREATE TRIGGER reject_lifecycle_receipt
      BEFORE INSERT ON lifecycle_transition_receipts
      BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END;
    `)

    db.db.exec('SAVEPOINT lifecycle_test')
    expect(() =>
      db!.transitionLifecycle({
        entity: 'task',
        id: task.id,
        from: 'ready',
        to: 'completed',
        receipt: { kind: 'test' }
      })
    ).toThrow('forced receipt failure')
    db.db.exec('ROLLBACK TO lifecycle_test')
    db.db.exec('RELEASE lifecycle_test')

    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getLifecycleTransitionReceipts('task', task.id)).toEqual([])
  })
})
