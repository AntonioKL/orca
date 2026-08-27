import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

const DISPATCH_IDENTITY_COLUMNS = [
  'retry_of_dispatch_id',
  'creator_dispatch_id',
  'creator_role',
  'endpoint_id',
  'endpoint_incarnation',
  'host_scope',
  'attachment_kind',
  'resource_id'
] as const

describe('R1 identity migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('survives v30 to v31 to v30-writer to v31 without guessing provenance', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-r1-identity-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const task = db.createTask({ spec: 'legacy supervised worker' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { worktree: 'folder:/workspace' },
      runtimeEpoch: 'runtime-v30',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_old',
      paneKey: 'tab_old:leaf_old',
      processIncarnation: 'pty_old:incarnation-old',
      worktreeId: 'folder:/workspace',
      hostScope: JSON.stringify({ kind: 'ssh', targetId: 'box-old' }),
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    const resourceId = db.getWorkerTerminalResourceByOwner(started.dispatch.id)?.id
    db.close()
    db = undefined

    const v30 = new Database(dbPath)
    v30.exec(
      'DROP INDEX IF EXISTS idx_dispatch_retry_of; DROP INDEX IF EXISTS idx_dispatch_resource;'
    )
    for (const column of DISPATCH_IDENTITY_COLUMNS) {
      v30.exec(`ALTER TABLE dispatch_contexts DROP COLUMN ${column}`)
    }
    v30.exec('ALTER TABLE worker_terminal_resources DROP COLUMN endpoint_id')
    v30.exec('ALTER TABLE worker_terminal_resources DROP COLUMN endpoint_incarnation')
    v30.pragma('user_version = 30')
    v30.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
      retry_of_dispatch_id: null,
      creator_dispatch_id: null,
      creator_role: null,
      endpoint_id: 'runtime-v30',
      endpoint_incarnation: null,
      host_scope: null,
      attachment_kind: null,
      resource_id: resourceId
    })
    db.close()
    db = undefined

    const oldWriter = new Database(dbPath)
    oldWriter.pragma('user_version = 30')
    oldWriter.exec(`
      INSERT INTO tasks (id, spec, status) VALUES ('task_old_writer', 'old writer', 'dispatched');
      INSERT INTO dispatch_contexts (id, task_id, status)
        VALUES ('ctx_old_writer', 'task_old_writer', 'dispatched');
    `)
    oldWriter.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById('ctx_old_writer')).toMatchObject({
      retry_of_dispatch_id: null,
      creator_dispatch_id: null,
      creator_role: null,
      endpoint_id: null,
      attachment_kind: null,
      resource_id: null
    })
  })
})
