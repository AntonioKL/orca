import { mkdir } from 'node:fs/promises'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { JournalLoad } from './journal-open'
import { JOURNAL_MIN_SESSION_BYTES } from './journal-database-space'
import { assertJournalPhysicalCapacity, journalDirectoryBytes } from './journal-physical-quota'
import type { JournalSuffixQuarantine } from './journal-suffix-quarantine'

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

/** The disclosure row for a repair. Rows the repair rejected are SET ASIDE, not
 *  destroyed, and saying so is the difference between "your history is gone" and
 *  "your history is not being shown". */
export function journalRepairDisclosure(input: {
  malformedRows: number
  quarantinedRows: number
}): {
  identity: { provider: 'orca'; clientMessageId: string }
  body: { kind: 'status'; text: string }
} {
  const lines = `${input.malformedRows} journal line${input.malformedRows === 1 ? '' : 's'}`
  const preserved =
    input.quarantinedRows > 0
      ? `; ${input.quarantinedRows} row${input.quarantinedRows === 1 ? '' : 's'} after it were set aside and remain recoverable`
      : ''
  return {
    // One stable identity, so a reopen upserts the same row instead of adding one.
    identity: { provider: 'orca', clientMessageId: 'journal-malformed-lines' },
    body: {
      kind: 'status',
      text: `${lines} could not be read${preserved}`
    }
  }
}

export async function openJournalStoreState(input: {
  journalDir: string
  sessionId: string
  loaded: JournalLoad | null | undefined
  replay: () => JournalLoad | null
  quarantineSuffix: (fromSeq: number) => Promise<JournalSuffixQuarantine>
  start: () => Promise<void>
  adopt: (loaded: JournalLoad) => void
  snapshot: () => AgentJournalSnapshot
  rebuildLifecycle: (snapshot: AgentJournalSnapshot, physicalBytes: number) => void
  appendDisclosure: (
    identity: ReturnType<typeof journalRepairDisclosure>['identity'],
    body: ReturnType<typeof journalRepairDisclosure>['body'],
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
  malformedRows: () => number
  readOnly: () => boolean
  setPhysicalBytes: (bytes: number) => void
  setQuarantinedRows: (count: number) => void
}): Promise<void> {
  const loaded = input.loaded !== undefined ? input.loaded : input.replay()
  if (!loaded) {
    await input.start()
    input.setPhysicalBytes(await journalDirectoryBytes(input.journalDir))
    return
  }
  input.adopt(loaded)
  let quarantinedRows = 0
  if (loaded.truncateFrom !== undefined && !loaded.readOnly) {
    // Preserved BEFORE anything is dropped: this call either sets the suffix
    // aside or throws, and a throw leaves `journal_rows` exactly as it was.
    quarantinedRows = (await input.quarantineSuffix(loaded.truncateFrom)).quarantinedRows
    input.setQuarantinedRows(quarantinedRows)
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
    const disclosure = journalRepairDisclosure({
      malformedRows: input.malformedRows(),
      quarantinedRows
    })
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
  }
  input.setPhysicalBytes(await journalDirectoryBytes(input.journalDir))
}
