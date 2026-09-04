import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  journalPragmaNumber,
  openJournalDatabase
} from './journal-database'
import {
  createJournalTablesSql,
  JOURNAL_DB_SCHEMA_VERSION,
  LEGACY_QUARANTINE_TABLE
} from './journal-database-schema'
import { JOURNAL_MIN_SESSION_BYTES } from './journal-database-space'
import { journalDatabaseFile } from './journal-paths'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { createTrackedJournalOpener } from './journal-store-test-open'
import {
  deleteAllJournalRows,
  insertJournalRow,
  moveJournalRowSuffixChunkToQuarantine,
  readJournalQuarantinedRows,
  readJournalEpochRows,
  readJournalRowsAfter,
  readJournalSessionEpoch,
  upsertJournalSessionRow
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const journals = createTrackedJournalOpener()

let root: string
let dbPath: string

function epochRow(seq: number, epoch = 'epoch-1'): JournalRow {
  return {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    seq,
    fence: 0,
    ts: 1_700_000_000_000 + seq
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
  dbPath = journalDatabaseFile(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A journal exactly as v1 left it: the same rows, and a quarantine keyed on
 *  `(session_id, epoch, seq)` holding one oversized rejected row. */
function seedV1JournalWithQuarantine(quarantineBytes: number): void {
  const seeded = new Database(dbPath)
  seeded.pragma('auto_vacuum = INCREMENTAL')
  seeded.pragma('journal_mode = WAL')
  seeded.exec(createJournalTablesSql())
  seeded.exec('DROP TABLE journal_quarantine')
  seeded.exec(`CREATE TABLE journal_quarantine (
  session_id     TEXT    NOT NULL,
  epoch          TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  row_json       TEXT    NOT NULL,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
)`)
  insertJournalRow(seeded, 'session-1', epochRow(1))
  upsertJournalSessionRow(seeded, 'session-1', 'epoch-1', 1)
  seeded
    .prepare('INSERT INTO journal_quarantine VALUES (?, ?, ?, ?, ?, ?)')
    .run('session-1', 'epoch-1', 2, 7, legacyQuarantineJson(quarantineBytes), 11)
  seeded.pragma('user_version = 1')
  seeded.pragma('wal_checkpoint(TRUNCATE)')
  seeded.close()
}

function legacyQuarantineJson(bytes: number): string {
  const empty = JSON.stringify({ kind: 'item', pad: '' })
  return `${empty.slice(0, -2)}${'x'.repeat(Math.max(bytes - empty.length, 0))}"}`
}

describe('journal database open', () => {
  it('creates both tables and reads back every load-bearing pragma', () => {
    const opened = openJournalDatabase(dbPath)
    try {
      const tables = opened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((entry) => (entry as { name: string }).name)
      expect(tables).toContain('journal_rows')
      expect(tables).toContain('journal_sessions')
      expect(opened.db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(journalPragmaNumber(opened.db, 'synchronous')).toBe(2)
      expect(journalPragmaNumber(opened.db, 'auto_vacuum')).toBe(2)
      expect(journalPragmaNumber(opened.db, 'wal_autocheckpoint')).toBe(0)
      expect(journalPragmaNumber(opened.db, 'busy_timeout')).toBe(JOURNAL_BUSY_TIMEOUT_MS)
      expect(journalPragmaNumber(opened.db, 'foreign_keys')).toBe(1)
      expect(journalPragmaNumber(opened.db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
      expect(opened.pageSize).toBeGreaterThan(0)
      expect(opened.readOnly).toBe(false)
    } finally {
      opened.db.close()
    }
  })

  it('keeps auto_vacuum and wal_autocheckpoint on a reopen', () => {
    openJournalDatabase(dbPath).db.close()
    const reopened = openJournalDatabase(dbPath)
    try {
      expect(journalPragmaNumber(reopened.db, 'auto_vacuum')).toBe(2)
      expect(journalPragmaNumber(reopened.db, 'wal_autocheckpoint')).toBe(0)
      expect(journalPragmaNumber(reopened.db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    } finally {
      reopened.db.close()
    }
  })

  // Why: WAL stamps the file header, and a later auto_vacuum change is then
  // ignored with no error. Without this negative half a future reorder passes.
  it('loses auto_vacuum entirely when WAL is set first', () => {
    const raw = new Database(dbPath)
    try {
      raw.pragma('journal_mode = WAL')
      raw.pragma('auto_vacuum = INCREMENTAL')
      expect(Number(raw.pragma('auto_vacuum', { simple: true }))).toBe(0)
    } finally {
      raw.close()
    }
  })

  it('latches read-only on a future user_version without touching the file', async () => {
    const seeded = openJournalDatabase(dbPath)
    upsertJournalSessionRow(seeded.db, 'session-1', 'epoch-1', 1)
    insertJournalRow(seeded.db, 'session-1', epochRow(1))
    seeded.db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 5}`)
    seeded.db.close()
    const before = await stat(dbPath)

    const latched = openJournalDatabase(dbPath)
    try {
      expect(latched.readOnly).toBe(true)
      expect(journalPragmaNumber(latched.db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION + 5)
      expect(readJournalEpochRows(latched.db, 'session-1', 'epoch-1')).toHaveLength(1)
      expect(() => latched.db.exec("INSERT INTO journal_sessions VALUES ('x', 'y', 1)")).toThrow()
    } finally {
      latched.db.close()
    }
    expect((await stat(dbPath)).size).toBe(before.size)
    expect(journalPragmaNumber(openJournalDatabase(dbPath).db, 'user_version')).toBe(
      JOURNAL_DB_SCHEMA_VERSION + 5
    )
  })

  // Site 1: the raw connection is owned by the open call until it returns.
  it('closes the raw connection when schema setup throws', async () => {
    const failing = join(root, 'nested', 'journal.db')
    expect(() => openJournalDatabase(failing)).toThrow()
    await expect(stat(`${failing}-wal`)).rejects.toThrow()
    await expect(rm(root, { recursive: true, force: true })).resolves.toBeUndefined()
    root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
  })
})

describe('journal row statements', () => {
  it('serves replay, resume, discard and suffix truncation from the primary key', () => {
    const opened = openJournalDatabase(dbPath)
    try {
      const { db } = opened
      db.exec('BEGIN IMMEDIATE')
      for (let seq = 1; seq <= 5; seq += 1) {
        insertJournalRow(db, 'session-1', epochRow(seq))
      }
      insertJournalRow(db, 'session-1', epochRow(1, 'epoch-old'))
      upsertJournalSessionRow(db, 'session-1', 'epoch-1', 42)
      db.exec('COMMIT')

      expect(readJournalSessionEpoch(db, 'session-1')).toBe('epoch-1')
      expect(readJournalSessionEpoch(db, 'absent')).toBeNull()
      expect(readJournalEpochRows(db, 'session-1', 'epoch-1').map((row) => row.seq)).toEqual([
        1, 2, 3, 4, 5
      ])
      expect(readJournalRowsAfter(db, 'session-1', 'epoch-1', 3).map((row) => row.seq)).toEqual([
        4, 5
      ])

      // The suffix leaves `journal_rows` and lands in `journal_quarantine`; the
      // chunk is one transaction, so it can never be half-done.
      expect(
        moveJournalRowSuffixChunkToQuarantine({
          db,
          sessionId: 'session-1',
          epoch: 'epoch-1',
          floorSeq: 4,
          quarantinedAt: 99
        })
      ).toBe(2)
      expect(readJournalEpochRows(db, 'session-1', 'epoch-1').map((row) => row.seq)).toEqual([
        1, 2, 3
      ])
      expect(readJournalQuarantinedRows(db, 'session-1').map((row) => row.seq)).toEqual([4, 5])
      expect(readJournalEpochRows(db, 'session-1', 'epoch-old')).toHaveLength(1)

      deleteAllJournalRows(db)
      expect(readJournalEpochRows(db, 'session-1', 'epoch-1')).toHaveLength(0)
      expect(readJournalEpochRows(db, 'session-1', 'epoch-old')).toHaveLength(0)
      expect(readJournalSessionEpoch(db, 'session-1')).toBe('epoch-1')
    } finally {
      opened.db.close()
    }
  })

  // A v1 database keyed the quarantine on `(session_id, epoch, seq)`, so a
  // second repair overwrote what the first preserved once the live journal
  // reused the freed sequences. Carry those rows forward, then prove the
  // rebuilt table accepts the collision v1 dropped.
  it('rekeys a sequence-keyed quarantine onto the surrogate without losing a row', () => {
    const seeded = new Database(dbPath)
    seeded.exec(`CREATE TABLE journal_quarantine (
  session_id     TEXT    NOT NULL,
  epoch          TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  row_json       TEXT    NOT NULL,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
)`)
    seeded
      .prepare('INSERT INTO journal_quarantine VALUES (?, ?, ?, ?, ?, ?)')
      .run('session-1', 'epoch-1', 3, 7, '{"first":true}', 11)
    seeded.pragma('user_version = 1')
    seeded.close()

    const opened = openJournalDatabase(dbPath)
    try {
      expect(journalPragmaNumber(opened.db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
      expect(readJournalQuarantinedRows(opened.db, 'session-1')).toEqual([
        { epoch: 'epoch-1', seq: 3, ts: 7, rowJson: '{"first":true}' }
      ])

      insertJournalRow(opened.db, 'session-1', epochRow(3))
      moveJournalRowSuffixChunkToQuarantine({
        db: opened.db,
        sessionId: 'session-1',
        epoch: 'epoch-1',
        floorSeq: 3,
        quarantinedAt: 12
      })
      expect(readJournalQuarantinedRows(opened.db, 'session-1').map((row) => row.rowJson)).toEqual([
        '{"first":true}',
        expect.stringContaining('"kind":"epoch"')
      ])
    } finally {
      opened.db.close()
    }
  })

  it('refuses a duplicate sequence inside one epoch', () => {
    const opened = openJournalDatabase(dbPath)
    try {
      insertJournalRow(opened.db, 'session-1', epochRow(1))
      expect(() => insertJournalRow(opened.db, 'session-1', epochRow(1))).toThrow()
      insertJournalRow(opened.db, 'session-1', epochRow(1, 'epoch-2'))
    } finally {
      opened.db.close()
    }
  })

  it('upserts the session projection in place', () => {
    const opened = openJournalDatabase(dbPath)
    try {
      upsertJournalSessionRow(opened.db, 'session-1', 'epoch-1', 1)
      upsertJournalSessionRow(opened.db, 'session-1', 'epoch-2', 2)
      expect(readJournalSessionEpoch(opened.db, 'session-1')).toBe('epoch-2')
      expect(
        opened.db.prepare('SELECT count(*) AS total FROM journal_sessions').get()
      ).toMatchObject({ total: 1 })
    } finally {
      opened.db.close()
    }
  })
})

// A quarantine holds whole rejected rows, so it can be megabytes. Copying it
// forward doubled the database inside one transaction, left the source pages on
// the freelist, and the NEXT open then refused the session it had just migrated.
describe('a v1 quarantine migration', () => {
  const LEGACY_ROW_BYTES = 4 * 1024 * 1024

  it('carries a large legacy quarantine across without breaching the session bound', async () => {
    seedV1JournalWithQuarantine(LEGACY_ROW_BYTES)
    const before = await journalDirectoryBytes(root)
    expect(before).toBeGreaterThan(LEGACY_ROW_BYTES)
    // A bound that admits the journal as it stands, and nothing like a copy of it.
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxSessionBytes: before + JOURNAL_MIN_SESSION_BYTES
    }

    const migrated = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    expect(migrated.recoverQuarantinedRows()).toHaveLength(1)
    await migrated.close()
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(limits.maxSessionBytes)

    // Same bound, next launch: a migration that strands the session is the same
    // outage as one that loses it.
    const reopened = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    expect(reopened.recoverQuarantinedRows()[0]?.rowJson).toHaveLength(LEGACY_ROW_BYTES)
    await reopened.close()
  })

  it('reads both quarantine generations after the rekey', () => {
    seedV1JournalWithQuarantine(64)
    const opened = openJournalDatabase(dbPath)
    try {
      expect(
        opened.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(LEGACY_QUARANTINE_TABLE)
      ).toBeTruthy()
      insertJournalRow(opened.db, 'session-1', epochRow(2))
      moveJournalRowSuffixChunkToQuarantine({
        db: opened.db,
        sessionId: 'session-1',
        epoch: 'epoch-1',
        floorSeq: 2,
        quarantinedAt: 12
      })
      // The frozen v1 row and the new one share `(epoch, seq)`; both are read.
      expect(readJournalQuarantinedRows(opened.db, 'session-1').map((row) => row.seq)).toEqual([
        2, 2
      ])
    } finally {
      opened.db.close()
    }
  })

  // Creating the tables outside the migration transaction left a v2-shaped
  // database still reporting version 0, which an older build does not latch
  // read-only: it stamps its own version on and writes through v1 SQL.
  it('publishes no table until the version bump commits with it', () => {
    const original = Database.prototype.pragma
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      if (sql.startsWith('user_version =')) {
        throw new Error('crash before the version is published')
      }
      return original.call(this, sql, options)
    })

    expect(() => openJournalDatabase(dbPath)).toThrow('crash before the version is published')
    pragma.mockRestore()

    const inspected = new Database(dbPath)
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(0)
      expect(
        inspected
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_rows'")
          .get()
      ).toBeUndefined()
    } finally {
      inspected.close()
    }
  })
})
