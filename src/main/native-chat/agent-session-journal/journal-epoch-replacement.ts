// Republishing a live item set into a fresh epoch.
//
// One transaction: discard every row, insert the epoch row plus the replacement
// items, and move the session projection. Blobs are files, so they are written
// BEFORE the transaction and cleaned up by hand when it rolls back — a ROLLBACK
// gives that guarantee for rows and nothing at all for files.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import {
  journalBlobFileSize,
  pruneJournalBlobs,
  putJournalBlob,
  removeJournalBlob
} from './journal-blob-store'
import { checkpointJournalWal, reclaimJournalDatabaseSpace } from './journal-database-space'
import { assertEpochTransactionFits } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import { journalDirectoryBytes } from './journal-physical-quota'
import {
  applyJournalRow,
  blobDigestsInBody,
  createJournalReducerState,
  referencedBlobDigests,
  type JournalReducerState
} from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import {
  deleteAllJournalRows,
  insertJournalRow,
  upsertJournalSessionRow
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence, type JournalAppendBudget } from './journal-write-guards'

export type JournalReplacementItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  blobs?: readonly { digest: string; payload: string }[]
  observedAt?: number
}

type StagedBlob = { digest: string; payload: string }

export async function replaceJournalEpoch(input: {
  db: Database.Database
  pageSize: number
  journalDir: string
  dbPath: string
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  budget: JournalAppendBudget
  now: () => number
  mintEpoch: () => string
  onPublished: (loaded: JournalLoad) => void
}): Promise<void> {
  const epoch = input.mintEpoch()
  const state = createJournalReducerState(input.identity.sessionId, epoch)
  const epochRow: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.identity.providerHandle,
    ...journalRowBase(epoch, 1, input.fence, input.now())
  }
  const rows: JournalRow[] = [epochRow]
  applyJournalRow(state, epochRow)
  for (const item of input.items) {
    const row = buildJournalItemRow({
      state,
      identity: item.identity,
      body: item.body,
      seq: state.lastSequence + 1,
      fence: input.fence,
      ts: item.observedAt ?? input.now()
    })
    assertJournalFence(row.fence, state.highestFence)
    applyJournalRow(state, row)
    rows.push(row)
  }

  const staged = await unstoredReplacementBlobs(input.journalDir, input.items)
  // The replacement needs room for the new content alongside the old: it
  // publishes atomically, so a session whose replacement does not fit is
  // refused and the live epoch is left exactly as it was.
  await assertEpochTransactionFits({
    journalDir: input.journalDir,
    dbPath: input.dbPath,
    sessionId: input.identity.sessionId,
    pageSize: input.pageSize,
    maxSessionBytes: input.budget.maxSessionBytes,
    rows,
    additionalBytes: staged.reduce(
      (total, blob) => total + Buffer.byteLength(blob.payload, 'utf8'),
      0
    )
  })

  const persisted: string[] = []
  try {
    for (const blob of staged) {
      await putJournalBlob(input.journalDir, blob.digest, blob.payload)
      persisted.push(blob.digest)
    }
    input.db.exec('BEGIN IMMEDIATE')
    try {
      deleteAllJournalRows(input.db)
      for (const row of rows) {
        insertJournalRow(input.db, input.identity.sessionId, row)
      }
      upsertJournalSessionRow(input.db, input.identity.sessionId, epoch, epochRow.ts)
      input.db.exec('COMMIT')
    } catch (error) {
      input.db.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    // Every staged digest was absent from disk before this call, so removing
    // them returns the directory to its pre-replacement state.
    for (const digest of persisted) {
      await removeJournalBlob(input.journalDir, digest)
    }
    throw error
  }

  checkpointJournalWal(input.db)
  await reclaimJournalDatabaseSpace({
    db: input.db,
    journalDir: input.journalDir,
    dbPath: input.dbPath,
    maxBytes: input.budget.maxSessionBytes,
    pageSize: input.pageSize
  })
  await pruneJournalBlobs(input.journalDir, replacementRetainedBlobDigests(state, rows))
  state.oldestSequence = 1
  input.onPublished({
    state,
    readOnly: false,
    corrupt: false,
    malformedRows: 0,
    sizeBytes: await journalDirectoryBytes(input.journalDir)
  })
}

function replacementRetainedBlobDigests(
  state: JournalReducerState,
  rows: readonly JournalRow[]
): Set<string> {
  const retained = referencedBlobDigests(state)
  for (const row of rows) {
    if (row.kind === 'item') {
      blobDigestsInBody(row.body, retained)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        if (mutation.kind === 'item') {
          blobDigestsInBody(mutation.body, retained)
        }
      }
    }
  }
  return retained
}

async function unstoredReplacementBlobs(
  journalDir: string,
  items: readonly JournalReplacementItem[]
): Promise<StagedBlob[]> {
  const unique = new Map<string, StagedBlob>()
  for (const item of items) {
    for (const blob of item.blobs ?? []) {
      unique.set(blob.digest, blob)
    }
  }
  const staged: StagedBlob[] = []
  for (const blob of unique.values()) {
    if ((await journalBlobFileSize(journalDir, blob.digest)) === null) {
      staged.push(blob)
    }
  }
  return staged
}
