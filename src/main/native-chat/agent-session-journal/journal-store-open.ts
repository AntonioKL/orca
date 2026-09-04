import { mkdir } from 'node:fs/promises'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { checkpointJournalWal, reclaimJournalDatabaseSpace } from './journal-database-space'
import type { JournalLoad } from './journal-open'
import { JOURNAL_MIN_SESSION_BYTES } from './journal-database-space'
import { assertJournalPhysicalCapacity, journalDirectoryBytes } from './journal-physical-quota'
import { deleteJournalRowSuffixChunk, readJournalEpochTipSequence } from './journal-row-table'

/** Sequences dropped per commit while truncating an unusable suffix. */
const SUFFIX_TRUNCATION_CHUNK = 512

export async function ensureJournalDir(journalDir: string): Promise<void> {
  await mkdir(journalDir, { recursive: true })
}

/** Asserted BEFORE a connection exists: opening one materializes ~57 KiB, so a
 *  sub-floor quota has to fail here rather than as a run of append failures. */
export function assertJournalOpenCapacity(input: {
  journalDir: string
  sessionId: string
  maxBytes: number
}): Promise<number> {
  return assertJournalPhysicalCapacity({ ...input, minBytes: JOURNAL_MIN_SESSION_BYTES })
}

export function journalStoreLoadedFields(loaded: JournalLoad) {
  return {
    state: loaded.state,
    sizeBytes: loaded.sizeBytes,
    readOnly: loaded.readOnly,
    malformedRows: loaded.malformedRows
  }
}

/** The disclosure row for rows that failed to parse. Skipped rows are lost
 *  rows; counting them silently is the drop this exists to prevent. */
export function malformedRowsDisclosure(count: number): {
  identity: { provider: 'orca'; clientMessageId: string }
  body: { kind: 'status'; text: string }
} {
  const plural = count === 1 ? '' : 's'
  return {
    // One stable identity, so a reopen upserts the same row instead of adding one.
    identity: { provider: 'orca', clientMessageId: 'journal-malformed-lines' },
    body: {
      kind: 'status',
      text: `${count} journal line${plural} could not be read and ${count === 1 ? 'was' : 'were'} skipped`
    }
  }
}

export async function openJournalStoreState(input: {
  journalDir: string
  sessionId: string
  loaded: JournalLoad | null | undefined
  replay: () => JournalLoad | null
  truncateSuffix: (fromSeq: number) => Promise<void>
  start: () => Promise<void>
  adopt: (loaded: JournalLoad) => void
  snapshot: () => AgentJournalSnapshot
  rebuildLifecycle: (snapshot: AgentJournalSnapshot, physicalBytes: number) => void
  appendDisclosure: (
    identity: ReturnType<typeof malformedRowsDisclosure>['identity'],
    body: ReturnType<typeof malformedRowsDisclosure>['body'],
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
  malformedRows: () => number
  readOnly: () => boolean
  setPhysicalBytes: (bytes: number) => void
}): Promise<void> {
  const loaded = input.loaded !== undefined ? input.loaded : input.replay()
  if (!loaded) {
    await input.start()
    input.setPhysicalBytes(await journalDirectoryBytes(input.journalDir))
    return
  }
  input.adopt(loaded)
  if (loaded.truncateFrom !== undefined && !loaded.readOnly) {
    await input.truncateSuffix(loaded.truncateFrom)
  }
  const physicalBytes = await journalDirectoryBytes(input.journalDir)
  input.setPhysicalBytes(physicalBytes)
  // A future-schema/read-only journal is inspection-only. Its reduced state is
  // intentionally empty, and rebuilding reservations from it would mutate the
  // in-memory quota model (and could influence later admission decisions).
  if (!loaded.readOnly) {
    input.rebuildLifecycle(input.snapshot(), physicalBytes)
  }
  if (input.malformedRows() > 0 && !input.readOnly()) {
    const disclosure = malformedRowsDisclosure(input.malformedRows())
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
  }
  input.setPhysicalBytes(await journalDirectoryBytes(input.journalDir))
}

/**
 * Drop everything at or after `fromSeq`. Issued in descending chunks, each with
 * its own commit and checkpoint: a suffix delete leaves a valid prefix at every
 * commit, so chunking needs no atomicity it does not already have. The
 * truncate optimization cannot apply to a qualified delete, which is why the
 * WAL is bounded by hand here.
 */
export async function truncateJournalSuffix(input: {
  db: Database.Database
  dbPath: string
  journalDir: string
  pageSize: number
  sessionId: string
  epoch: string
  fromSeq: number
  maxBytes: number
}): Promise<void> {
  let tip = readJournalEpochTipSequence(input.db, input.sessionId, input.epoch)
  while (tip >= input.fromSeq) {
    const floor = Math.max(input.fromSeq, tip - SUFFIX_TRUNCATION_CHUNK + 1)
    deleteJournalRowSuffixChunk(input.db, input.sessionId, input.epoch, floor)
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
}
