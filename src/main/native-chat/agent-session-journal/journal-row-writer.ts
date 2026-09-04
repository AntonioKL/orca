import type Database from '../../sqlite/sync-database'
import {
  journalBlobFileSize,
  pruneJournalBlobs,
  putJournalBlob,
  removeJournalBlob
} from './journal-blob-store'
import {
  checkpointJournalWal,
  journalReclaimBandBytes,
  journalTxnPhysicalCost,
  journalWalBytes
} from './journal-database-space'
import { blobDigestsInBody } from './journal-reducer'
import { journalDirectoryBytes } from './journal-physical-quota'
import type { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import { insertJournalRow, upsertJournalSessionRow } from './journal-row-table'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'
import {
  assertJournalFence,
  assertJournalWritable,
  type JournalAppendBudget
} from './journal-write-guards'

type JournalBlob = { digest: string; payload: string }

export type JournalRowWriterDeps = {
  journalDir: string
  dbPath: string
  sessionId: string
  budget: JournalAppendBudget
  lifecycleAdmission: JournalLifecycleAdmission
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => { db: Database.Database; pageSize: number }
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  referencedBlobDigests: () => ReadonlySet<string>
  commit: (row: JournalRow, physicalBytes: number) => void
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    blobs: readonly JournalBlob[] = []
  ): Promise<JournalRow> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const ts = this.deps.now()
      const row = build(this.deps.nextSequence(), ts)
      assertJournalFence(row.fence, this.deps.highestFence())
      const { db, pageSize } = this.deps.database()
      const rowCostBytes = journalTxnPhysicalCost([journalRowByteLength(row)], pageSize)

      let measured = await journalDirectoryBytes(this.deps.journalDir)
      const admission = this.deps.lifecycleAdmission.prepare(row, measured)
      let newBlobs = await uniqueNewBlobs(this.deps.journalDir, blobs)
      let walBytes = await journalWalBytes(this.deps.dbPath)
      let effectiveSize = this.effectiveSize({ measured, newBlobs, walBytes, pageSize }, admission)

      if (this.deps.budget.wouldExceedSize(rowCostBytes, effectiveSize)) {
        // Budget pressure. No row is ever shed inside an epoch, so what is left
        // to shed is unreferenced BLOB bytes — the unbounded byte source. The
        // protected set must include this row's own digests: content addressing
        // never rewrites a digest already on disk, so pruning on live reducer
        // state alone deletes the blob this very append is about to cite.
        await pruneJournalBlobs(this.deps.journalDir, this.protectedDigests(row, blobs))
        newBlobs = await uniqueNewBlobs(this.deps.journalDir, blobs)
        checkpointJournalWal(db)
        measured = await journalDirectoryBytes(this.deps.journalDir)
        walBytes = await journalWalBytes(this.deps.dbPath)
        effectiveSize = this.effectiveSize({ measured, newBlobs, walBytes, pageSize }, admission)
      }

      const lifecycleRateCheckpoint = admission.lifecycleCovered
        ? this.deps.budget.checkpoint()
        : null
      const appendRateCheckpoint = this.deps.budget.checkpoint()
      try {
        if (admission.lifecycleCovered) {
          this.deps.budget.assertReservedLifecycle(rowCostBytes, effectiveSize)
        } else {
          this.deps.budget.assert(rowCostBytes, ts, effectiveSize)
        }
        await this.commitFiles(db, row, newBlobs)
      } catch (error) {
        if (lifecycleRateCheckpoint) {
          this.deps.budget.restore(lifecycleRateCheckpoint)
        }
        this.deps.budget.restore(appendRateCheckpoint)
        throw error
      }
      // The trailing checkpoint is what leaves the WAL empty for the next
      // admission check; the counter is set from the measurement, never accrued.
      checkpointJournalWal(db)
      this.deps.commit(row, await journalDirectoryBytes(this.deps.journalDir))
      this.deps.lifecycleAdmission.commit(admission)
      return row
    })
  }

  private effectiveSize(
    input: {
      measured: number
      newBlobs: readonly JournalBlob[]
      walBytes: number
      pageSize: number
    },
    admission: { protectedBytes: number }
  ): number {
    const blobBytes = input.newBlobs.reduce(
      (total, blob) => total + Buffer.byteLength(blob.payload, 'utf8'),
      0
    )
    return (
      input.measured +
      blobBytes +
      admission.protectedBytes +
      journalReclaimBandBytes(input.measured, input.pageSize) +
      input.walBytes
    )
  }

  private async commitFiles(
    db: Database.Database,
    row: JournalRow,
    blobs: readonly JournalBlob[]
  ): Promise<void> {
    const persisted: string[] = []
    try {
      for (const blob of blobs) {
        await putJournalBlob(this.deps.journalDir, blob.digest, blob.payload)
        persisted.push(blob.digest)
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        insertJournalRow(db, this.deps.sessionId, row)
        upsertJournalSessionRow(db, this.deps.sessionId, row.epoch, row.ts)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      // Every digest in `persisted` was absent from disk before this append, so
      // removing the unreferenced ones returns the directory to its prior state.
      const retained = this.deps.referencedBlobDigests()
      for (const digest of persisted) {
        if (!retained.has(digest)) {
          await removeJournalBlob(this.deps.journalDir, digest)
        }
      }
      throw error
    }
  }

  /** Live reducer digests ∪ every digest the candidate row carries — its
   *  `blobs` argument AND its own body, because a row can cite a digest that is
   *  not in that argument at all. */
  private protectedDigests(row: JournalRow, blobs: readonly JournalBlob[]): Set<string> {
    const protectedSet = new Set(this.deps.referencedBlobDigests())
    for (const blob of blobs) {
      protectedSet.add(blob.digest)
    }
    if (row.kind === 'item') {
      blobDigestsInBody(row.body, protectedSet)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        if (mutation.kind === 'item') {
          blobDigestsInBody(mutation.body, protectedSet)
        }
      }
    }
    return protectedSet
  }
}

async function uniqueNewBlobs(
  journalDir: string,
  blobs: readonly JournalBlob[]
): Promise<JournalBlob[]> {
  const unique = new Map(blobs.map((blob) => [blob.digest, blob]))
  const result: JournalBlob[] = []
  for (const blob of unique.values()) {
    if ((await journalBlobFileSize(journalDir, blob.digest)) === null) {
      result.push(blob)
    }
  }
  return result
}
