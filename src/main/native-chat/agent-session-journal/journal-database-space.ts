// What a journal transaction costs on disk, and how deleted pages come back.
//
// SQLite grows the database in pages and the WAL in frames, and the checkpoint
// that copies the WAL forward holds the same pages in BOTH files at once — so a
// transaction's peak is about twice its content, not equal to it. A row's JSON
// length is therefore its INPUT to the charge, never the charge itself.

import { stat } from 'node:fs/promises'
import type Database from '../../sqlite/sync-database'
import { JOURNAL_BUSY_TIMEOUT_MS } from './journal-database'
import { JOURNAL_ROW_KEY_BYTES } from './journal-key-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { journalFreelistCount } from './journal-row-table'

/**
 * Pages the WAL carries beyond the ones a transaction newly allocates: page 1,
 * the pointer map `auto_vacuum` maintains, and the modified interior chain of
 * all four b-trees this schema has — `journal_rows` and `journal_sessions` are
 * each a table plus the implicit unique index their composite primary key
 * creates. Measured worst requirement was 13 pages on a 256 MB database; the
 * sweep in `journal-database-space.test.ts` is what keeps this honest.
 */
export const JOURNAL_TXN_FIXED_PAGES = 24

/** An open, empty journal costs 57,344 bytes before a single row exists; the
 *  smallest append costs 247,200 more and the reclaim band 65,920. Below this a
 *  journal cannot open, hold one row, and still reclaim. */
export const JOURNAL_MIN_SESSION_BYTES = 524_288

const RECLAIM_CHUNK_PAGES = 2048
const RECLAIM_SLACK_FRACTION = 0.9

export function journalWalFrameBytes(pageSize: number): number {
  return pageSize + 24
}

/**
 * Upper bound on the directory growth of one transaction, computed from the
 * transaction's own rows. Monotone non-decreasing in row bytes, which is what
 * lets a lifecycle reservation granted for N logical bytes cover the page cost
 * of any row no larger than N.
 */
export function journalTxnPhysicalCost(
  rowJsonByteLengths: readonly number[],
  pageSize: number
): number {
  const usable = pageSize - 4
  let dataPages = 0
  for (const bytes of rowJsonByteLengths) {
    // Overflow chain plus the leaf cell that heads it. The key bytes are added
    // because `(session_id, epoch)` is stored per row in BOTH the table and the
    // primary-key index and appears nowhere in `row_json`.
    dataPages += Math.ceil((Math.max(bytes, 0) + JOURNAL_ROW_KEY_BYTES) / usable) + 1
  }
  // Every journal transaction also upserts the `journal_sessions` projection,
  // which stores its own bounded copy of both keys in a table and an index.
  const projectionPages = Math.ceil(JOURNAL_ROW_KEY_BYTES / usable) + 2
  // `dataPages / 256` covers the pointer-map pages `auto_vacuum` maintains.
  const pages = dataPages + projectionPages + JOURNAL_TXN_FIXED_PAGES + Math.ceil(dataPages / 256)
  return 2 * journalWalFrameBytes(pageSize) * pages
}

/** Headroom the two shrinking operations need in order to run at all: the
 *  truncate-optimized epoch discard's WAL and the first reclaim chunk. */
export function journalReclaimBandBytes(measured: number, pageSize: number): number {
  return Math.max(16 * journalWalFrameBytes(pageSize), Math.ceil(Math.max(measured, 0) / 256))
}

/** The only reliable statement of "nothing is deferred". A busy checkpoint can
 *  copy most of its frames forward and still leave the file on disk, and
 *  `wal_checkpoint(PASSIVE)` reports `busy: 0` having truncated nothing. */
export async function journalWalBytes(dbPath: string): Promise<number> {
  try {
    return (await stat(`${dbPath}-wal`)).size
  } catch (error) {
    // ENOENT is the only answer that PROVES nothing is deferred. A permission,
    // I/O or transient metadata failure is unknown state, and reporting it as
    // zero both undercharges admission and lets reclamation run on a false
    // empty-WAL predicate — so everything else fails closed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }
}

/**
 * Best-effort explicit checkpoint. The busy handler is suppressed for its
 * duration: a blocked TRUNCATE otherwise waits the full `busy_timeout` and
 * returns the byte-identical result it returns immediately without it, on a
 * write path whose whole point is that the submission row is durable before
 * dispatch.
 */
export function checkpointJournalWal(db: Database.Database): void {
  try {
    db.pragma('busy_timeout = 0')
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // A checkpoint that cannot run is carried by the `walBytes` admission term.
  } finally {
    try {
      db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
    } catch {
      // The connection is gone; nothing left to restore.
    }
  }
}

/**
 * Return freed pages to the filesystem in bounded chunks, each sized from the
 * slack it has. A single unbounded `incremental_vacuum` took a 252 MB directory
 * to 504 MB — the reclamation added to defend the bound would breach it.
 */
export async function reclaimJournalDatabaseSpace(input: {
  db: Database.Database
  journalDir: string
  dbPath: string
  maxBytes: number
  pageSize: number
}): Promise<void> {
  // A non-empty WAL means the preceding checkpoint could not drain: vacuuming
  // now writes more WAL and reclaims nothing. The freelist survives for the
  // next attempt.
  if ((await journalWalBytes(input.dbPath)) !== 0) {
    return
  }
  const walFrame = journalWalFrameBytes(input.pageSize)
  let freelist = journalFreelistCount(input.db)
  while (freelist > 0) {
    const slack = input.maxBytes - (await journalDirectoryBytes(input.journalDir))
    const pages = Math.floor((slack * RECLAIM_SLACK_FRACTION) / walFrame)
    // Nonpositive slack is a stop, not a floor: clamping up to one page
    // guarantees a write in the one case the bound cannot afford it.
    if (pages < 1) {
      return
    }
    // Stepped to completion — a single-step call frees ONE page regardless of N.
    input.db.pragma(`incremental_vacuum(${Math.min(pages, RECLAIM_CHUNK_PAGES)})`)
    checkpointJournalWal(input.db)
    if ((await journalWalBytes(input.dbPath)) !== 0) {
      return
    }
    const remaining = journalFreelistCount(input.db)
    if (remaining >= freelist) {
      return
    }
    freelist = remaining
  }
}
