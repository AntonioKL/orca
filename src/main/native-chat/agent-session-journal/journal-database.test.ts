import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  journalPragmaNumber,
  openJournalDatabase
} from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabaseFile } from './journal-paths'
import {
  deleteAllJournalRows,
  deleteJournalRowSuffixChunk,
  insertJournalRow,
  readJournalEpochRows,
  readJournalRowsAfter,
  readJournalSessionEpoch,
  upsertJournalSessionRow
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

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
  await rm(root, { recursive: true, force: true })
})

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

      deleteJournalRowSuffixChunk(db, 'session-1', 'epoch-1', 4)
      expect(readJournalEpochRows(db, 'session-1', 'epoch-1').map((row) => row.seq)).toEqual([
        1, 2, 3
      ])
      expect(readJournalEpochRows(db, 'session-1', 'epoch-old')).toHaveLength(1)

      deleteAllJournalRows(db)
      expect(readJournalEpochRows(db, 'session-1', 'epoch-1')).toHaveLength(0)
      expect(readJournalEpochRows(db, 'session-1', 'epoch-old')).toHaveLength(0)
      expect(readJournalSessionEpoch(db, 'session-1')).toBe('epoch-1')
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
