// Corruption never deletes history.
//
// Replay stops at the first row this build cannot represent, or at the first
// row after a sequence gap. Everything from there on is REJECTED, not worthless:
// the rows past a hole are usually intact, and the Orca-owned ones — a
// submission, its acceptance receipt, a lifecycle mutation — carry identity that
// no provider transcript can reconstruct, because Orca minted it.
//
// So the suffix is copied into `journal_quarantine` and only then deleted from
// `journal_rows`, both in ONE transaction per chunk. A crash between the two is
// impossible; a crash between chunks leaves a valid prefix and a partially
// quarantined suffix, and the next open resumes from the same point because the
// copy is an upsert. If the copy does not fit inside the session's physical
// bound the open FAILS instead of destroying the rows — the same answer the
// file-backed journal gave when its quarantine did not fit.

import type Database from '../../sqlite/sync-database'
import { checkpointJournalWal, reclaimJournalDatabaseSpace } from './journal-database-space'
import { journalTxnPhysicalCost } from './journal-database-space'
import { assertJournalPhysicalCapacity } from './journal-physical-quota'
import {
  countJournalRowSuffix,
  moveJournalRowSuffixChunkToQuarantine,
  readJournalEpochTipSequence
} from './journal-row-table'

/** Sequences moved per commit while quarantining an unusable suffix. */
const SUFFIX_QUARANTINE_CHUNK = 512

export type JournalSuffixQuarantine = {
  /** Rows preserved in `journal_quarantine` and removed from the live epoch. */
  quarantinedRows: number
  /** First sequence of the rejected suffix, so a repair can be described. */
  fromSequence: number
}

/**
 * Preserve everything at or after `fromSeq`, then drop it from the live epoch.
 * Issued in descending chunks, each with its own commit and checkpoint: a suffix
 * move leaves a valid prefix at every commit, so chunking needs no atomicity it
 * does not already have.
 */
export async function quarantineJournalSuffix(input: {
  db: Database.Database
  dbPath: string
  journalDir: string
  pageSize: number
  sessionId: string
  epoch: string
  fromSeq: number
  maxBytes: number
  now: number
}): Promise<JournalSuffixQuarantine> {
  const suffix = countJournalRowSuffix(input.db, input.sessionId, input.epoch, input.fromSeq)
  if (suffix.rowJsonByteLengths.length === 0) {
    return { quarantinedRows: 0, fromSequence: input.fromSeq }
  }
  // The copy is charged before a byte of it is written, so a session that cannot
  // afford to preserve its own suffix refuses to open rather than destroying it.
  await assertJournalPhysicalCapacity({
    journalDir: input.journalDir,
    sessionId: input.sessionId,
    maxBytes: input.maxBytes,
    peakAdditionalBytes: journalTxnPhysicalCost(suffix.rowJsonByteLengths, input.pageSize)
  })

  let moved = 0
  let tip = readJournalEpochTipSequence(input.db, input.sessionId, input.epoch)
  while (tip >= input.fromSeq) {
    const floor = Math.max(input.fromSeq, tip - SUFFIX_QUARANTINE_CHUNK + 1)
    moved += moveJournalRowSuffixChunkToQuarantine({
      db: input.db,
      sessionId: input.sessionId,
      epoch: input.epoch,
      floorSeq: floor,
      quarantinedAt: input.now
    })
    checkpointJournalWal(input.db)
    tip = floor - 1
  }
  await reclaimJournalDatabaseSpace({
    db: input.db,
    journalDir: input.journalDir,
    dbPath: input.dbPath,
    maxBytes: input.maxBytes,
    pageSize: input.pageSize
  })
  return { quarantinedRows: moved, fromSequence: input.fromSeq }
}
