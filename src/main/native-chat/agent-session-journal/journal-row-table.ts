// Every statement the journal issues against `journal_rows` / `journal_sessions`.
//
// Each one is a prefix or range scan on the `(session_id, epoch, seq)` primary
// key; there is no secondary index, and no `max(seq)` tip query — replay folds
// the epoch to obtain `lastSequence`, so nothing needs the tip from SQL.
// Columns are always named: `SELECT *` is uncacheable and can drop a column.

import type Database from '../../sqlite/sync-database'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

const SELECT_SESSION = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const UPSERT_SESSION = `INSERT INTO journal_sessions (session_id, epoch, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at`
const INSERT_ROW =
  'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
const SELECT_EPOCH_ROWS = `SELECT epoch, seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? ORDER BY seq ASC`
const SELECT_ROWS_AFTER = `SELECT epoch, seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC`
const DELETE_SUFFIX = 'DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq >= ?'
const SELECT_SUFFIX_LENGTHS = `SELECT length(row_json) AS bytes FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq >= ? ORDER BY seq ASC`
// `INSERT OR REPLACE`, so a repair interrupted between chunks resumes instead of
// failing on the rows it already preserved.
const QUARANTINE_SUFFIX = `INSERT OR REPLACE INTO journal_quarantine
  (session_id, epoch, seq, ts, row_json, quarantined_at)
SELECT session_id, epoch, seq, ts, row_json, ? FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq >= ?`
const SELECT_QUARANTINED = `SELECT epoch, seq, ts, row_json FROM journal_quarantine
WHERE session_id = ? ORDER BY epoch ASC, seq ASC`

export function readJournalSessionEpoch(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(SELECT_SESSION).get(sessionId) as { epoch?: string } | undefined
  return row?.epoch ?? null
}

export function upsertJournalSessionRow(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  updatedAt: number
): void {
  db.prepare(UPSERT_SESSION).run(sessionId, epoch, updatedAt)
}

export function insertJournalRow(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): number {
  const rowJson = serializeJournalRow(row)
  db.prepare(INSERT_ROW).run(sessionId, row.epoch, row.seq, row.ts, rowJson)
  return Buffer.byteLength(rowJson, 'utf8')
}

export function readJournalEpochRows(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalStoredRow[] {
  return toStoredRows(db.prepare(SELECT_EPOCH_ROWS).all(sessionId, epoch))
}

export function readJournalRowsAfter(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSeq: number
): JournalStoredRow[] {
  return toStoredRows(db.prepare(SELECT_ROWS_AFTER).all(sessionId, epoch, afterSeq))
}

/**
 * Unqualified on purpose. One database per session means every row here belongs
 * to this session, and the unqualified form takes SQLite's truncate
 * optimization: measured at 0.26% of the database in WAL bytes where the
 * `WHERE session_id = ?` form rewrote every emptied leaf at up to 99%.
 */
export function deleteAllJournalRows(db: Database.Database): void {
  db.exec('DELETE FROM journal_rows')
}

/** Row-body lengths of a rejected suffix, in sequence order. The quarantine
 *  charges the copy from these before it writes a byte of it. */
export function countJournalRowSuffix(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  fromSeq: number
): { rowJsonByteLengths: number[] } {
  const rows = db.prepare(SELECT_SUFFIX_LENGTHS).all(sessionId, epoch, fromSeq) as {
    bytes: number
  }[]
  return { rowJsonByteLengths: rows.map((row) => row.bytes) }
}

/**
 * One descending chunk of a rejected suffix, PRESERVED and then removed inside a
 * single transaction. The copy and the delete cannot be separated by a crash,
 * which is the whole reason the repair is not two statements at the call site.
 */
export function moveJournalRowSuffixChunkToQuarantine(input: {
  db: Database.Database
  sessionId: string
  epoch: string
  floorSeq: number
  quarantinedAt: number
}): number {
  input.db.exec('BEGIN IMMEDIATE')
  try {
    input.db
      .prepare(QUARANTINE_SUFFIX)
      .run(input.quarantinedAt, input.sessionId, input.epoch, input.floorSeq)
    const deleted = input.db
      .prepare(DELETE_SUFFIX)
      .run(input.sessionId, input.epoch, input.floorSeq)
    input.db.exec('COMMIT')
    return Number(deleted.changes ?? 0)
  } catch (error) {
    input.db.exec('ROLLBACK')
    throw error
  }
}

/** Everything a repair set aside for this session, newest epoch last. The rows
 *  stay verbatim, so a later build that can parse them can replay them. */
export function readJournalQuarantinedRows(
  db: Database.Database,
  sessionId: string
): JournalStoredRow[] {
  return toStoredRows(db.prepare(SELECT_QUARANTINED).all(sessionId))
}

export function journalFreelistCount(db: Database.Database): number {
  return Number(db.pragma('freelist_count', { simple: true }) ?? 0)
}

function toStoredRows(rows: readonly unknown[]): JournalStoredRow[] {
  return rows.map((entry) => {
    const record = entry as { epoch: string; seq: number; ts: number; row_json: string }
    return { epoch: record.epoch, seq: record.seq, ts: record.ts, rowJson: record.row_json }
  })
}

/** Highest sequence in an epoch. The only caller is malformed-suffix
 *  truncation, which walks its chunks down from the tip. */
export function readJournalEpochTipSequence(
  db: Database.Database,
  sessionId: string,
  epoch: string
): number {
  const row = db
    .prepare(
      'SELECT seq FROM journal_rows WHERE session_id = ? AND epoch = ? ORDER BY seq DESC LIMIT 1'
    )
    .get(sessionId, epoch) as { seq?: number } | undefined
  return row?.seq ?? 0
}
