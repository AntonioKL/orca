import { mkdir } from 'node:fs/promises'
import {
  findJournalFileFormatRemnant,
  journalFileFormatRemnantDisclosure,
  journalFileFormatSourceNeedsCheck,
  journalFileFormatSourceWasDisclosed,
  readJournalFileFormatRemnant,
  type JournalFileFormatRemnant
} from './journal-file-format-remnant'
import type { JournalFileImportRecord } from './journal-file-import-marker'
import { FIRST_JOURNAL_SEQUENCE, type JournalLoad } from './journal-open'
import type { JournalReducerState } from './journal-reducer'
import { journalRepairDisclosure, type JournalRepairDisclosure } from './journal-repair-disclosure'
import { JournalFileFormatStateInvalidError } from './journal-state-replacement'

export async function ensureJournalDir(journalDir: string): Promise<void> {
  await mkdir(journalDir, { recursive: true })
}

export function journalStoreLoadedFields(loaded: JournalLoad) {
  return {
    state: loaded.state,
    readOnly: loaded.readOnly,
    malformedRows: loaded.malformedRows
  }
}

export async function openJournalStoreState(input: {
  journalDir: string
  loaded: JournalLoad | null | undefined
  replay: () => JournalLoad | null
  /** Drops the rejected suffix and records the rebuild it owes, in ONE
   *  transaction. Corruption is not preserved; replay keeps reporting `corrupt`
   *  until provider history republishes the epoch or the session writes past
   *  `contentFrom`, the first sequence the repair left free. */
  deleteSuffix: (fromSeq: number, contentFrom: number) => number
  start: () => void
  adopt: (loaded: JournalLoad) => void
  /** Republishes an anchor row for an epoch a repair emptied. */
  publishRepairEpoch: () => void
  appendDisclosure: (
    identity: JournalRepairDisclosure['identity'],
    body: JournalRepairDisclosure['body'],
    fence: number
  ) => Promise<unknown>
  /** Rolls a fresh epoch holding the complete restored state, in one transaction. */
  replaceState: (state: JournalReducerState, sourceFingerprint: string) => Promise<unknown>
  importRecord: () => JournalFileImportRecord | null
  recordImportAttempt: (sourceFingerprint: string, retainsRestoredState: boolean) => void
  sessionId: string
  highestFence: () => number
  malformedRows: () => number
  setMalformedRows: (count: number) => void
  readOnly: () => boolean
}): Promise<void> {
  const loaded = input.loaded !== undefined ? input.loaded : input.replay()
  if (!loaded) {
    input.start()
    await restoreFileFormatRemnant(input, null, false)
    return
  }
  input.adopt(loaded)
  if (loaded.truncateFrom !== undefined && !loaded.readOnly) {
    input.deleteSuffix(loaded.truncateFrom, loaded.state.lastSequence + 1)
  }
  // A repair that took every live row leaves the epoch with no anchor. Publish
  // one before anything can append into it: an ordinary row at sequence 1 would
  // replay as a clean timeline and hide that the history was never rebuilt.
  if (!loaded.readOnly && loaded.state.lastSequence === 0) {
    input.publishRepairEpoch()
    // The replacement epoch adopts a clean load; what this open's repair did is
    // still the answer `repair` and the disclosure below owe the caller.
    input.setMalformedRows(loaded.malformedRows)
  }
  if (input.malformedRows() > 0 && !input.readOnly()) {
    const disclosure = journalRepairDisclosure({ malformedRows: input.malformedRows() })
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
    return
  }
  // A journal already re-founded empty beside its own unreadable remnant — one
  // this build opened before it disclosed anything — still owes the
  // explanation. Bounded to an epoch holding nothing but its anchor, so a
  // session the user has since written into is never appended to.
  const importRecord =
    !input.readOnly() && journalFileFormatSourceWasDisclosed(loaded.state)
      ? input.importRecord()
      : null
  const retainsRestoredState = importRecord?.retainsRestoredState ?? false
  if (
    loaded.state.lastSequence <= FIRST_JOURNAL_SEQUENCE ||
    journalFileFormatSourceNeedsCheck(loaded.state, retainsRestoredState)
  ) {
    await restoreFileFormatRemnant(input, importRecord, retainsRestoredState)
  }
}

type FileFormatRemnantHandling = {
  journalDir: string
  sessionId: string
  appendDisclosure: (
    identity: JournalRepairDisclosure['identity'],
    body: JournalRepairDisclosure['body'],
    fence: number
  ) => Promise<unknown>
  replaceState: (state: JournalReducerState, sourceFingerprint: string) => Promise<unknown>
  importRecord: () => JournalFileImportRecord | null
  recordImportAttempt: (sourceFingerprint: string, retainsRestoredState: boolean) => void
  highestFence: () => number
  readOnly: () => boolean
}

/** Replays the pre-SQLite files into this journal. Successful state, disclosure,
 *  and source fingerprint land together; failed reads disclose before marking. */
async function restoreFileFormatRemnant(
  input: FileFormatRemnantHandling,
  importRecord: JournalFileImportRecord | null,
  retainsRestoredState: boolean
): Promise<void> {
  if (input.readOnly()) {
    return
  }
  const remnant = await findJournalFileFormatRemnant(input.journalDir)
  if (!remnant) {
    return
  }
  if (importRecord?.sourceFingerprint === remnant.sourceFingerprint) {
    return
  }
  const restored = await readJournalFileFormatRemnant(remnant, input.sessionId)
  if (restored.status === 'restored') {
    try {
      await input.replaceState(restored.state, remnant.sourceFingerprint)
    } catch (error) {
      if (!(error instanceof JournalFileFormatStateInvalidError)) {
        throw error
      }
      await discloseFileFormatRemnantFailure(input, remnant, retainsRestoredState)
      return
    }
    return
  }
  await discloseFileFormatRemnantFailure(input, remnant, retainsRestoredState)
}

async function discloseFileFormatRemnantFailure(
  input: FileFormatRemnantHandling,
  remnant: JournalFileFormatRemnant,
  retainsRestoredState: boolean
): Promise<void> {
  const disclosure = journalFileFormatRemnantDisclosure(remnant)
  await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
  input.recordImportAttempt(remnant.sourceFingerprint, retainsRestoredState)
}
