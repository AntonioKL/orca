import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type Database from '../../../sqlite/sync-database'
import { OrchestrationDb } from '../../orchestration/db'
import type { FederatedDispatchRow } from '../../orchestration/types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { encodeWorkerListCursor } from './orchestration-worker-list-cursor'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './orchestration-worker-list-method'

type WorkerListResult = {
  workers: {
    dispatchId: string
    projection: { attention: { categories: string[] } }
  }[]
  counts: Record<string, number>
  page: { total: number; hasMore: boolean; nextCursor: string | null }
}

describe('orchestration worker-list pagination', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('returns a complete filtered legacy result while current clients page above 100 rows', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Mixed-version worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    for (let index = 0; index < 125; index += 1) {
      insertDispatch(db, run.id, `dispatch-${String(index).padStart(3, '0')}`)
    }

    const legacy = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained'
    })
    expect(legacy.workers).toHaveLength(125)
    expect(legacy.page).toEqual({ total: 125, limit: 5_000, hasMore: false, nextCursor: null })

    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      paginate: true
    })
    expect(first.workers).toHaveLength(100)
    expect(first.page).toMatchObject({ total: 125, hasMore: true })
    expect(first.page.nextCursor).toEqual(expect.any(String))
    expect(first.page.nextCursor).not.toBe('dispatch-099')

    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      paginate: true,
      cursor: first.page.nextCursor
    })
    expect(second.workers).toHaveLength(25)
    expect(second.page).toEqual({ total: 125, limit: 100, hasMore: false, nextCursor: null })
  })

  it('fails an omitted-pagination legacy result above the explicit safety ceiling', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(db, 'listWorkerTerminalResources').mockReturnValue(
      Array.from({ length: 5_001 }, () => null) as never
    )

    await expect(callWorkerList(runtime, {})).rejects.toMatchObject({
      code: 'worker_list_snapshot_too_large',
      message: expect.stringContaining('at most 5000 rows')
    })
  })

  it('excludes later same-second rows that sort between snapshot cursors', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const first = await callWorkerList(runtime, { run: run.id, limit: 1 })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
    expect(first.page).toMatchObject({ total: 2, hasMore: true })
    expect(first.page.nextCursor).toEqual(expect.any(String))

    insertDispatch(db, run.id, 'dispatch-m')

    const second = await callWorkerList(runtime, {
      run: run.id,
      limit: 1,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
    expect(second.page).toEqual({ total: 2, limit: 1, hasMore: false, nextCursor: null })
  })

  it('continues a version-one snapshot cursor from an older runtime', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Compatible worker inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    const cursor = encodeWorkerListCursor({
      version: 1,
      snapshot: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-z' },
      after: { createdAt: '2026-08-27 00:00:00', dispatchId: 'dispatch-a' }
    })

    const page = await callWorkerList(runtime, { run: run.id, limit: 1, cursor })

    expect(page.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
    expect(page.page).toEqual({ total: 2, limit: 1, hasMore: false, nextCursor: null })
  })

  it('keeps filtered snapshot membership when a later worker changes state', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Stable filtered inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')

    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1
    })
    expect(first.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-a'])
    expect(first.page).toMatchObject({ total: 2, hasMore: true })

    sqliteFor(db)
      .prepare('UPDATE dispatch_contexts SET assignee_handle = NULL WHERE id = ?')
      .run('dispatch-z')
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
    expect(second.page).toEqual({ total: 2, limit: 1, hasMore: false, nextCursor: null })
  })

  it('keeps an include-remote filtered page pinned across 32 concurrent snapshot allocations', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Pinned filtered inventory',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    vi.spyOn(db, 'getFederatedDispatch').mockImplementation((dispatchId) =>
      dispatchId === 'dispatch-a' ? federatedDispatch(dispatchId) : undefined
    )
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment-remote',
      name: 'remote',
      peerFingerprint: 'peer-remote',
      pairingRevision: 1
    })
    let resolveStatus!: (status: ReturnType<typeof fleetRuntimeStatus>) => void
    const status = new Promise<ReturnType<typeof fleetRuntimeStatus>>((resolve) => {
      resolveStatus = resolve
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation((_environmentId, method) => {
        if (method === 'status.get') {
          return status
        }
        return Promise.resolve({
          runtimeEpoch: 'epoch-remote',
          items: [
            {
              dispatchId: 'dispatch-a',
              observation: { status: 'live', exactWorker: true }
            }
          ]
        })
      })

    const pending = callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      includeRemote: true,
      limit: 1
    })
    await vi.waitFor(() =>
      expect(remoteCall).toHaveBeenCalledWith(
        'environment-remote',
        'status.get',
        undefined,
        expect.any(Number),
        undefined,
        { expectedEnvironmentPairingRevision: 1 }
      )
    )
    for (let call = 0; call < 32; call += 1) {
      await callWorkerList(runtime, { run: run.id, terminalState: 'retained', limit: 1 })
    }
    resolveStatus(fleetRuntimeStatus())

    const first = await pending
    expect(first).toMatchObject({
      workers: [{ dispatchId: 'dispatch-a' }],
      page: { total: 2, hasMore: true, nextCursor: expect.any(String) }
    })
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })
    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
  })

  it('does not allocate filtered snapshots when the first page has no more rows', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Snapshot-free terminal page',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertDispatch(db, run.id, 'dispatch-a')
    insertDispatch(db, run.id, 'dispatch-z')
    const first = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1
    })

    for (let call = 0; call < 32; call += 1) {
      const terminalPage = await callWorkerList(runtime, {
        run: run.id,
        terminalState: 'released',
        limit: 1
      })
      expect(terminalPage.page).toMatchObject({ total: 0, hasMore: false, nextCursor: null })
    }
    const second = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'retained',
      limit: 1,
      cursor: first.page.nextCursor
    })

    expect(second.workers.map((worker) => worker.dispatchId)).toEqual(['dispatch-z'])
  })

  it('projects a 100-row page within six synchronous read statements', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Bounded worker inventory reads',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    for (let index = 0; index < 100; index += 1) {
      insertDispatch(db, run.id, `dispatch-${String(index).padStart(3, '0')}`)
    }
    db.recordAttemptObservation({
      id: 'observation-failed-worker',
      dispatchId: 'dispatch-050',
      sequence: 0,
      authorityId: 'home',
      authorityClock: 'home',
      facet: 'worker_report',
      payload: { status: 'accepted', outcome: 'failed' },
      homeReceivedAt: Date.now()
    })
    const prepare = vi.spyOn(sqliteFor(db), 'prepare')
    prepare.mockClear()

    const page = await callWorkerList(runtime, { run: run.id, limit: 100 })

    expect(page.workers.map((worker) => worker.dispatchId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `dispatch-${String(index).padStart(3, '0')}`)
    )
    expect(page.workers[50]?.projection.attention.categories).toContain('failure')
    expect(page.page).toEqual({ total: 100, limit: 100, hasMore: false, nextCursor: null })
    expect(prepare).toHaveBeenCalledTimes(6)
  })

  it('aggregates exact inventory counts while preserving filtered totals', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Exact worker inventory counts',
      coordinatorHandle: 'term-coordinator',
      coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    insertWorkerInventory(db, run.id, 'active', 'ready', 'not_requested')
    insertWorkerInventory(db, run.id, 'reclaimable-a', 'succeeded', 'not_requested')
    insertWorkerInventory(db, run.id, 'reclaimable-b', 'failed', 'not_requested')
    insertDispatch(db, run.id, 'retained')
    insertWorkerInventory(db, run.id, 'released', 'succeeded', 'released', 'released')
    insertWorkerInventory(db, run.id, 'release-pending', 'ready', 'requested')
    insertWorkerInventory(db, run.id, 'release-unknown', 'ready', 'unknown')

    const page = await callWorkerList(runtime, { run: run.id })
    const filtered = await callWorkerList(runtime, {
      run: run.id,
      terminalState: 'reclaimable'
    })

    expect(page.counts).toEqual({
      active: 1,
      reclaimable: 2,
      retained: 1,
      release_pending: 1,
      release_unknown: 1,
      released: 1
    })
    expect(page.page.total).toBe(7)
    expect(filtered.workers.map((worker) => worker.dispatchId)).toEqual([
      'reclaimable-a',
      'reclaimable-b'
    ])
    expect(filtered.page.total).toBe(2)
    expect(filtered.counts).toEqual(page.counts)
  })
})

async function callWorkerList(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown>
): Promise<WorkerListResult> {
  const parsed = ORCHESTRATION_WORKER_LIST_METHOD.params?.parse(params)
  return (await ORCHESTRATION_WORKER_LIST_METHOD.handler(parsed, { runtime })) as WorkerListResult
}

function insertDispatch(db: OrchestrationDb, runId: string, dispatchId: string): void {
  const task = db.createTask({ spec: dispatchId, runId })
  sqliteFor(db)
    .prepare(
      `INSERT INTO dispatch_contexts (
         id, run_id, task_id, assignee_handle, status, created_at
       ) VALUES (?, ?, ?, ?, 'dispatched', '2026-08-27 00:00:00')`
    )
    .run(dispatchId, runId, task.id, `term-${dispatchId}`)
}

function insertWorkerInventory(
  db: OrchestrationDb,
  runId: string,
  dispatchId: string,
  workerState: 'ready' | 'succeeded' | 'failed',
  releaseState: 'not_requested' | 'requested' | 'released' | 'unknown',
  ownershipState: 'owned' | 'released' = 'owned'
): void {
  insertDispatch(db, runId, dispatchId)
  const sqlite = sqliteFor(db)
  sqlite
    .prepare(
      `INSERT INTO worker_dispatches (
         dispatch_id, state, stage, agent_terminal_handle
       ) VALUES (?, ?, 'ready', ?)`
    )
    .run(dispatchId, workerState, `term-${dispatchId}`)
  sqlite
    .prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
         ownership_state, release_state
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      `resource-${dispatchId}`,
      dispatchId,
      dispatchId,
      `term-${dispatchId}`,
      ownershipState,
      releaseState
    )
}

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function federatedDispatch(dispatchId: string): FederatedDispatchRow {
  return {
    dispatch_id: dispatchId,
    environment_id: 'environment-remote',
    environment_name: 'remote',
    peer_fingerprint: 'peer-remote',
    remote_runtime_epoch: 'epoch-remote',
    protocol_version: 3,
    remote_worktree_id: null,
    remote_terminal_handle: null,
    to_home_imported_sequence: 0,
    to_home_acknowledged_sequence: 0,
    created_at: '2026-08-27 00:00:00',
    updated_at: '2026-08-27 00:00:00'
  }
}

function fleetRuntimeStatus() {
  return {
    runtimeId: 'epoch-remote',
    capabilities: [ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY],
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}
