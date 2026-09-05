import { mkdir } from 'node:fs/promises'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import {
  findJournalFileFormatRemnant,
  journalFileFormatRemnantDisclosure,
  journalFileFormatRestoredDisclosure,
  readJournalFileFormatRemnantItems
} from './journal-file-format-remnant'
import { FIRST_JOURNAL_SEQUENCE, type JournalLoad } from './journal-open'
import { journalRepairDisclosure, type JournalRepairDisclosure } from './journal-repair-disclosure'

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
  /** Rolls a fresh epoch holding the restored timeline, in one transaction. */
  replaceEpoch: (items: readonly JournalReplacementItem[], fence: number) => Promise<unknown>
  sessionId: string
  highestFence: () => number
  malformedRows: () => number
  setMalformedRows: (count: number) => void
  readOnly: () => boolean
}): Promise<void> {
  const loaded = input.loaded !== undefined ? input.loaded : input.replay()
  if (!loaded) {
    input.start()
    await restoreFileFormatRemnant(input)
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
  if (loaded.state.lastSequence <= FIRST_JOURNAL_SEQUENCE) {
    await restoreFileFormatRemnant(input)
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
  replaceEpoch: (items: readonly JournalReplacementItem[], fence: number) => Promise<unknown>
  highestFence: () => number
  readOnly: () => boolean
}

/** Replays the pre-SQLite `log.jsonl` into this journal, and says what happened
 *  either way. The restore lands first so the disclosure describes a settled
 *  outcome, and both share one identity so the row is replaced, never doubled. */
async function restoreFileFormatRemnant(input: FileFormatRemnantHandling): Promise<void> {
  if (input.readOnly()) {
    return
  }
  const remnant = findJournalFileFormatRemnant(input.journalDir)
  if (!remnant) {
    return
  }
  const restored = await readJournalFileFormatRemnantItems(remnant, input.sessionId)
  if (restored.length > 0) {
    await input.replaceEpoch(restored, input.highestFence())
    const disclosure = journalFileFormatRestoredDisclosure({ restored: restored.length })
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
    return
  }
  const disclosure = journalFileFormatRemnantDisclosure(remnant)
  await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
}
