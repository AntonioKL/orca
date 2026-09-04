import { mkdir } from 'node:fs/promises'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { JournalLoad } from './journal-open'
import { JOURNAL_MIN_SESSION_BYTES } from './journal-database-space'
import { assertJournalPhysicalCapacity, journalDirectoryBytes } from './journal-physical-quota'
import { journalRepairDisclosure, type JournalRepairDisclosure } from './journal-repair-disclosure'
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
  /** Republishes an anchor row for an epoch a repair emptied. */
  publishRepairEpoch: () => Promise<void>
  appendDisclosure: (
    identity: JournalRepairDisclosure['identity'],
    body: JournalRepairDisclosure['body'],
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
  malformedRows: () => number
  setMalformedRows: (count: number) => void
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
  // A repair that took every live row leaves the epoch with no anchor. Publish
  // one before anything can append into it: an ordinary row at sequence 1 would
  // replay as a clean timeline and strand the quarantined history behind it.
  if (!loaded.readOnly && loaded.state.lastSequence === 0) {
    await input.publishRepairEpoch()
    // The replacement epoch adopts a clean load; what this open's repair did is
    // still the answer `repair` and the disclosure below owe the caller.
    input.setMalformedRows(loaded.malformedRows)
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
  // Rows set aside by a gap are perfectly valid and no line was unreadable, so
  // gating on `malformedRows` alone hid the repair that removes the most.
  if ((input.malformedRows() > 0 || quarantinedRows > 0) && !input.readOnly()) {
    const disclosure = journalRepairDisclosure({
      malformedRows: input.malformedRows(),
      quarantinedRows
    })
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
  }
  input.setPhysicalBytes(await journalDirectoryBytes(input.journalDir))
}
