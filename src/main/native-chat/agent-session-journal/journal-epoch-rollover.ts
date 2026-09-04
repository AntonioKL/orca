// Opening a new epoch.
//
// One transaction: discard every row of the superseded epoch, insert the new
// epoch row at sequence 1, and move the session projection onto it. Superseded
// rows are DELETED rather than retained — retaining them would grow the file
// against the physical bound forever, with nothing that ever sheds them.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import {
  checkpointJournalWal,
  journalReclaimBandBytes,
  journalTxnPhysicalCost,
  journalWalBytes,
  reclaimJournalDatabaseSpace
} from './journal-database-space'
import type { JournalLoad } from './journal-open'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { runJournalPostCommit } from './journal-post-commit'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  deleteAllJournalRows,
  insertJournalRow,
  upsertJournalSessionRow
} from './journal-row-table'
import { journalRowByteLength } from './journal-row-schema'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { AgentSessionJournalError } from './journal-write-guards'

export async function publishNewEpoch(input: {
  db: Database.Database
  pageSize: number
  journalDir: string
  dbPath: string
  sessionId: string
  providerHandle: AgentSessionProviderHandle
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  maxSessionBytes?: number
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
  setPhysicalBytes: (bytes: number) => void
}): Promise<void> {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.providerHandle,
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }
  const maxSessionBytes = input.maxSessionBytes ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS.maxSessionBytes
  const committed = await assertEpochTransactionFits({ ...input, maxSessionBytes, rows: [row] })

  input.db.exec('BEGIN IMMEDIATE')
  try {
    deleteAllJournalRows(input.db)
    insertJournalRow(input.db, input.sessionId, row)
    upsertJournalSessionRow(input.db, input.sessionId, input.epoch, input.now)
    input.db.exec('COMMIT')
  } catch (error) {
    input.db.exec('ROLLBACK')
    throw error
  }

  // COMMIT landed: on disk the superseded prefix is gone and this epoch is the
  // live one. The caller adopts that BEFORE reclamation and measurement, or a
  // failure in either leaves the store writing into an epoch that no longer
  // exists and moving the projection back onto it.
  const state = createJournalReducerState(input.sessionId, input.epoch)
  applyJournalRow(state, row)
  state.oldestSequence = 1
  input.onPublished({
    state,
    readOnly: false,
    corrupt: false,
    malformedRows: 0,
    sizeBytes: committed
  })

  const settled = await runJournalPostCommit({
    journalDir: input.journalDir,
    projectedBytes: committed,
    // Without reclamation the discarded pages sit on the freelist and the file
    // stays exactly as large as it was.
    housekeeping: async () => {
      checkpointJournalWal(input.db)
      await reclaimJournalDatabaseSpace({
        db: input.db,
        journalDir: input.journalDir,
        dbPath: input.dbPath,
        maxBytes: maxSessionBytes,
        pageSize: input.pageSize
      })
    }
  })
  input.setPhysicalBytes(settled.physicalBytes)
}

/** Charges the candidate transaction's own page cost, plus the band the
 *  shrinking operations need and any WAL a blocked checkpoint deferred.
 *  Returns the footprint the COMMIT itself can reach — the measurement plus the
 *  transaction's own charge — which is what a caller adopts when the
 *  post-commit scan cannot run. The band and the deferred WAL are admission
 *  terms, not committed bytes, so neither is in that answer. */
export async function assertEpochTransactionFits(input: {
  journalDir: string
  dbPath: string
  sessionId: string
  pageSize: number
  maxSessionBytes: number
  rows: readonly JournalRow[]
  additionalBytes?: number
}): Promise<number> {
  const measured = await journalDirectoryBytes(input.journalDir)
  const committed =
    measured +
    (input.additionalBytes ?? 0) +
    journalTxnPhysicalCost(input.rows.map(journalRowByteLength), input.pageSize)
  const projected =
    committed +
    journalReclaimBandBytes(measured, input.pageSize) +
    (await journalWalBytes(input.dbPath))
  if (projected > input.maxSessionBytes) {
    throw new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal for ${input.sessionId} reached its ${input.maxSessionBytes}-byte physical bound`
    )
  }
  return committed
}
