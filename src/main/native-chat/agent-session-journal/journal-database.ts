// Opening one session's journal database.
//
// `PRAGMA user_version` is read FIRST, on a connection that has set no
// persistent pragma and run no DDL: a future-schema database must be left
// byte-identical, and both `journal_mode = WAL` and `auto_vacuum` write the
// file header.

import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import {
  createJournalTablesSql,
  JOURNAL_DB_SCHEMA_VERSION,
  LEGACY_QUARANTINE_TABLE
} from './journal-database-schema'

export const JOURNAL_BUSY_TIMEOUT_MS = 5000

export type OpenJournalDatabase = {
  db: Database.Database
  /** A newer `user_version` was met: this build reads and never writes. */
  readOnly: boolean
  /** Read back, never assumed — the physical charge is page arithmetic. */
  pageSize: number
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

export function openJournalDatabase(dbPath: string): OpenJournalDatabase {
  const probe = new Database(dbPath)
  let stored: number
  try {
    stored = journalPragmaNumber(probe, 'user_version')
  } catch (error) {
    probe.close()
    throw error
  }
  if (stored > JOURNAL_DB_SCHEMA_VERSION) {
    probe.close()
    const latched = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      return { db: latched, readOnly: true, pageSize: journalPragmaNumber(latched, 'page_size') }
    } catch (error) {
      latched.close()
      throw error
    }
  }
  let transferred = false
  try {
    configureJournalPragmas(probe)
    migrateJournalDatabase(probe, stored)
    hardenSqliteDatabaseFiles(dbPath)
    const opened = {
      db: probe,
      readOnly: false,
      pageSize: journalPragmaNumber(probe, 'page_size')
    }
    transferred = true
    return opened
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

/**
 * `auto_vacuum` comes FIRST. SQLite honours a change to it only on an empty
 * database, and `journal_mode = WAL` stamps the header — set WAL first and the
 * later `auto_vacuum = INCREMENTAL` is ignored with no error, reclamation
 * silently becomes a no-op, and the file never shrinks again.
 */
function configureJournalPragmas(db: Database.Database): void {
  db.pragma('auto_vacuum = INCREMENTAL')
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // Why FULL rather than the house NORMAL: the write-ahead submission row must
  // survive a power loss before the adapter dispatches anything, and NORMAL in
  // WAL mode does not fsync at commit. It is also one fsync per commit against
  // the two the file substrate paid.
  db.pragma('synchronous = FULL')
  // Why: a checkpoint that fires inside an arbitrary commit makes a
  // transaction's physical cost depend on how many commits preceded it. Every
  // checkpoint here is explicit and charged.
  db.pragma('wal_autocheckpoint = 0')
}

/**
 * Table creation and the `user_version` bump are ONE transaction. Creating the
 * tables first left a v2-shaped database still reporting version 0, which an
 * older build does not latch read-only: it stamped its own version on and wrote
 * into the surrogate-keyed table through v1 SQL.
 */
function migrateJournalDatabase(db: Database.Database, stored: number): void {
  if (stored >= JOURNAL_DB_SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(createJournalTablesSql())
    freezeSequenceKeyedQuarantine(db)
    db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * v1 keyed `journal_quarantine` on `(session_id, epoch, seq)`, which a second
 * repair in the same epoch overwrote once the live journal reused the sequences
 * the first repair freed.
 *
 * The rows are not copied onto the new key. A quarantine holds whole rejected
 * rows, so copying one is unbounded work charged to nobody: a single 8 MiB row
 * nearly doubled the database, and the pages the dropped table freed only ever
 * reached the freelist. The v1 table is renamed and left alone — reads take the
 * union, and every write after this lands on the surrogate-keyed table.
 */
function freezeSequenceKeyedQuarantine(db: Database.Database): void {
  const columns = db.pragma('table_info(journal_quarantine)') as { name: string }[]
  if (columns.some((column) => column.name === 'quarantine_id')) {
    return
  }
  db.exec(`ALTER TABLE journal_quarantine RENAME TO ${LEGACY_QUARANTINE_TABLE}`)
  db.exec(createJournalTablesSql())
}
