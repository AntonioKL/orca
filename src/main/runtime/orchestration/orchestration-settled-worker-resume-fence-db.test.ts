import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'

const PANE_KEY = 'tab_worker:33333333-3333-4333-8333-333333333333'

describe('settled worker terminal resume fence rows', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createReadyWorker(): { db: OrchestrationDb; taskId: string; dispatchId: string } {
    const d = new OrchestrationDb(':memory:')
    db = d
    const task = d.createTask({ spec: 'settled worker' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    return { db: d, taskId: task.id, dispatchId: started.dispatch.id }
  }

  function requestRelease(d: OrchestrationDb, dispatchId: string): WorkerTerminalResourceRow {
    const requested = d.requestWorkerTerminalRelease(dispatchId)
    if (requested.disposition !== 'requested') {
      throw new Error(`expected a release request, got ${requested.disposition}`)
    }
    return requested.resource
  }

  function settle(d: OrchestrationDb, taskId: string, dispatchId: string): void {
    expect(
      d.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: JSON.stringify({ provenance: 'worker_report', outcome: 'succeeded' })
      }).action
    ).not.toBe('rejected')
  }

  it('keeps a settled-but-unreleased worker terminal in recovery rows', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([
      expect.objectContaining({
        dispatch_id: dispatchId,
        worker_state: 'succeeded',
        assignee_pane_key: PANE_KEY
      })
    ])
  })

  it('keeps a settled worker whose release is unknown', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)
    const resource = requestRelease(d, dispatchId)
    d.markWorkerTerminalReleaseUnknown(resource.id, 'terminal no longer resolves')
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([
      expect.objectContaining({ dispatch_id: dispatchId })
    ])
  })

  it('drops a settled worker once its resource is released', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    settle(d, taskId, dispatchId)
    const resource = requestRelease(d, dispatchId)
    d.settleWorkerTerminalRelease(resource.id)
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
  })

  it('drops a settled worker the user chose to retain', () => {
    const { db: d, taskId, dispatchId } = createReadyWorker()
    d.retainWorkerTerminalResource(dispatchId)
    settle(d, taskId, dispatchId)
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
  })
})
