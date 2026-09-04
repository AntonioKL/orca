// The write path's transaction and its reservation rollback.
//
// A transaction either commits or does not, so the old "a post-append failure
// makes durability ambiguous" latch has nothing left to latch on: every case
// that used to assert the latch now asserts the rollback instead.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { readJournalBlob } from './journal-blob-store'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import { journalTxnPhysicalCost } from './journal-database-space'
import { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import {
  journalReservationPhysicalBytes,
  JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES
} from './journal-lifecycle-capacity'
import { journalDatabaseFile } from './journal-paths'
import { boundPayload, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import {
  insertJournalRow,
  readJournalEpochRows,
  upsertJournalSessionRow
} from './journal-row-table'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalAppendBudget } from './journal-write-guards'

const SESSION_ID = 'session-1'
const EPOCH = 'epoch-1'

function row(seq: number, ts: number): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: EPOCH,
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId: 'item-1',
    revision: 1,
    body: { kind: 'status', text: 'plain append' }
  }
}

function rowWithBlob(seq: number, ts: number, output: ReturnType<typeof boundPayload>): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: EPOCH,
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId: 'item-with-blob',
    revision: 1,
    body: { kind: 'tool-call', name: 'shell', input: {}, state: 'completed', output }
  }
}

function runningToolBody(): AgentJournalItemBody {
  return { kind: 'tool-call', name: 'shell', input: {}, state: 'running' }
}

function runningToolRow(seq: number, ts: number, itemId = 'running-tool'): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: EPOCH,
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId,
    revision: 1,
    body: runningToolBody()
  }
}

describe('journal row writer', () => {
  let root: string
  let database: OpenJournalDatabase
  let readOnly = false

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-row-writer-'))
    database = openJournalDatabase(journalDatabaseFile(root))
    upsertJournalSessionRow(database.db, SESSION_ID, EPOCH, 1)
    readOnly = false
  })

  afterEach(async () => {
    try {
      database.db.close()
    } catch {
      // Already closed by the case.
    }
    await rm(root, { recursive: true, force: true })
  })

  it('enforces the lifecycle append rate and allows a retry after the window', () => {
    const appendWindowMs = 100
    const budget = new JournalAppendBudget(SESSION_ID, {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxAppendsPerWindow: 1,
      appendWindowMs
    })

    budget.assertLifecycle(1, 1, 0)
    expect(() => budget.assertLifecycle(1, 1, 0)).toThrow(
      expect.objectContaining({ code: 'journal_rate_exceeded' })
    )
    expect(() => budget.assertLifecycle(1, appendWindowMs + 1, 0)).not.toThrow()
  })

  it('refuses lifecycle reservations once aggregate append capacity is saturated', () => {
    const admission = new JournalLifecycleAdmission(SESSION_ID, 100_000_000, (id) => id, 2)
    expect(admission.reserve({ id: 'first', bytes: 1, appendSlots: 1 }, 0)).toBe(true)
    expect(admission.reserve({ id: 'second', bytes: 1, appendSlots: 1 }, 0)).toBe(true)
    expect(admission.reserve({ id: 'third', bytes: 1, appendSlots: 1 }, 0)).toBe(false)
  })

  function writerHarness(
    overrides: {
      limits?: typeof DEFAULT_JOURNAL_PAYLOAD_LIMITS
      commit?: (row: JournalRow, physicalBytes: number) => void
    } = {}
  ) {
    const limits = overrides.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    const lifecycleAdmission = new JournalLifecycleAdmission(
      SESSION_ID,
      limits.maxSessionBytes,
      (itemId) => itemId,
      limits.maxAppendsPerWindow,
      () => database.pageSize
    )
    let nextSequence = 1
    let physicalBytes = 0
    const committedRows: JournalRow[] = []
    const writer = new JournalRowWriter({
      journalDir: root,
      dbPath: journalDatabaseFile(root),
      sessionId: SESSION_ID,
      budget: new JournalAppendBudget(SESSION_ID, limits),
      lifecycleAdmission,
      now: () => 1,
      serialize: (run) => run(),
      database: () => database,
      readOnly: () => readOnly,
      highestFence: () => 0,
      nextSequence: () => nextSequence,
      referencedBlobDigests: () => new Set(),
      commit: (committed, nextPhysicalBytes) => {
        overrides.commit?.(committed, nextPhysicalBytes)
        committedRows.push(committed)
        physicalBytes = nextPhysicalBytes
        nextSequence = committed.seq + 1
      },
      setPhysicalBytes: (bytes) => {
        physicalBytes = bytes
      }
    })
    return { writer, lifecycleAdmission, committedRows, physical: () => physicalBytes }
  }

  it('rolls the transaction back and sets no latch when the insert fails', async () => {
    const { writer, committedRows } = writerHarness()
    // A row already occupies sequence 1, so the insert violates the primary key.
    insertJournalRow(database.db, SESSION_ID, row(1, 1))

    await expect(writer.enqueue(row)).rejects.toThrow()

    expect(readOnly).toBe(false)
    expect(committedRows).toHaveLength(0)
    expect(readJournalEpochRows(database.db, SESSION_ID, EPOCH)).toHaveLength(1)
    // Still writable: there is no ambiguity for a latch to protect against.
    await expect(writer.enqueue((seq, ts) => row(seq + 1, ts))).resolves.toMatchObject({
      kind: 'item'
    })
  })

  it('removes the blobs of a rolled-back row', async () => {
    const payload = 'speculative blob payload'.repeat(2_000)
    const bounded = boundPayload(payload, {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 32
    })
    const { writer } = writerHarness()
    insertJournalRow(database.db, SESSION_ID, row(1, 1))

    await expect(
      writer.enqueue(
        (seq, ts) => rowWithBlob(seq, ts, bounded),
        [{ digest: bounded.digest, payload }]
      )
    ).rejects.toThrow()

    expect(readOnly).toBe(false)
    expect(await readJournalBlob(root, bounded.digest)).toBeNull()
  })

  it('does not leak a lifecycle reservation after budget refusal', async () => {
    const probe = runningToolRow(1, 1)
    const measured = await journalDirectoryBytes(root)
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxSessionBytes:
        measured +
        journalReservationPhysicalBytes(JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES, 4096) +
        journalTxnPhysicalCost([journalRowByteLength(probe)], 4096) -
        1
    }
    const { writer, lifecycleAdmission, committedRows } = writerHarness({ limits })

    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).rejects.toMatchObject({
      code: 'journal_bound_exceeded'
    })

    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
    expect(committedRows).toHaveLength(0)
  })

  it('counts an existing durable-write temp before creating a blob or row', async () => {
    const tempBytes = 512
    await writeFile(join(root, 'blobs.existing-write.tmp'), 't'.repeat(tempBytes), 'utf8')
    const measured = await journalDirectoryBytes(root)
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxSessionBytes:
        measured + journalTxnPhysicalCost([journalRowByteLength(row(1, 1))], 4096) - 1
    }
    const { writer, committedRows } = writerHarness({ limits })

    await expect(writer.enqueue((seq, ts) => row(seq, ts))).rejects.toMatchObject({
      code: 'journal_bound_exceeded'
    })
    expect(committedRows).toHaveLength(0)
    expect(await readJournalBlob(root, 'a'.repeat(64))).toBeNull()
  })

  it('does not leak a lifecycle reservation after blob lookup failure', async () => {
    const { writer, lifecycleAdmission } = writerHarness()
    const digest = 'a'.repeat(64)
    await writeFile(join(root, 'blobs'), 'not a directory', 'utf8')

    await expect(
      writer.enqueue((seq, ts) => runningToolRow(seq, ts), [{ digest, payload: 'payload' }])
    ).rejects.toThrow()

    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
    await rm(join(root, 'blobs'), { force: true })
    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).resolves.toMatchObject({
      kind: 'item',
      itemId: 'running-tool'
    })
    expect(lifecycleAdmission.state).toEqual({
      reservedBytes: journalReservationPhysicalBytes(
        JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES,
        database.pageSize
      ),
      reservedAppendSlots: 1
    })
  })

  it('rolls back ordinary append-rate reservation after blob preflight failure', async () => {
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxAppendsPerWindow: 1,
      appendWindowMs: 100
    }
    const { writer, committedRows } = writerHarness({ limits })
    const payload = 'retryable blob payload'.repeat(100)
    const bounded = boundPayload(payload, limits)
    await writeFile(join(root, 'blobs'), 'not a directory', 'utf8')

    await expect(
      writer.enqueue(
        (seq, ts) => rowWithBlob(seq, ts, bounded),
        [{ digest: bounded.digest, payload }]
      )
    ).rejects.toThrow()

    await rm(join(root, 'blobs'), { force: true })
    await expect(
      writer.enqueue(
        (seq, ts) => rowWithBlob(seq, ts, bounded),
        [{ digest: bounded.digest, payload }]
      )
    ).resolves.toMatchObject({ kind: 'item', itemId: 'item-with-blob' })
    expect(committedRows).toHaveLength(1)
  })

  it('does not leak a lifecycle reservation after reducer commit failure', async () => {
    const { writer, lifecycleAdmission } = writerHarness({
      commit: () => {
        throw new Error('commit failed after the transaction')
      }
    })

    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).rejects.toThrow(
      'commit failed after the transaction'
    )

    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
  })
})
