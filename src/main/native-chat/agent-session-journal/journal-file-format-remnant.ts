import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { findSequenceGap } from './journal-cursor'
import {
  readJournalFileFormatSnapshot,
  seedJournalFileFormatSnapshot
} from './journal-file-format-snapshot'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

const FILE_FORMAT_LOG_FILE = 'log.jsonl'
const FILE_FORMAT_SNAPSHOT_FILE = 'snapshot.json'
const MAX_REMNANT_BYTES = 64 * 1024 * 1024
const MAX_REMNANT_ROWS = 200_000
const MAX_RESTORED_ITEMS = 20_000
const FILE_FORMAT_IMPORT_VERSION = 1

export type JournalFileFormatRemnant = {
  transcriptPath: string
  logPath: string | null
  snapshotPath: string | null
  totalBytes: number
  sourceFingerprint: string
}

export type JournalFileFormatRemnantRead =
  | { status: 'restored'; state: JournalReducerState }
  | { status: 'not-replayable' }

export async function findJournalFileFormatRemnant(
  journalDir: string
): Promise<JournalFileFormatRemnant | null> {
  const [log, snapshot] = await Promise.all([
    fileSize(join(journalDir, FILE_FORMAT_LOG_FILE)),
    fileSize(join(journalDir, FILE_FORMAT_SNAPSHOT_FILE))
  ])
  if (!log && !snapshot) {
    return null
  }
  const transcriptPath = snapshot?.path ?? log?.path
  if (!transcriptPath) {
    return null
  }
  return {
    transcriptPath,
    logPath: log?.path ?? null,
    snapshotPath: snapshot?.path ?? null,
    totalBytes: (log?.bytes ?? 0) + (snapshot?.bytes ?? 0),
    sourceFingerprint:
      `${FILE_FORMAT_IMPORT_VERSION}|log:${log?.fingerprint ?? 'missing'}` +
      `|snapshot:${snapshot?.fingerprint ?? 'missing'}`
  }
}

export async function readJournalFileFormatRemnant(
  remnant: JournalFileFormatRemnant,
  sessionId: string
): Promise<JournalFileFormatRemnantRead> {
  if (remnant.totalBytes > MAX_REMNANT_BYTES) {
    return { status: 'not-replayable' }
  }
  let state: JournalReducerState
  const snapshot = remnant.snapshotPath
    ? await readJournalFileFormatSnapshot(remnant.snapshotPath)
    : null
  if (snapshot && snapshot.status !== 'valid') {
    return { status: 'not-replayable' }
  }
  const rows = remnant.logPath
    ? await readLogRows(remnant.logPath)
    : { status: 'valid' as const, rows: [] }
  if (rows.status !== 'valid') {
    return { status: 'not-replayable' }
  }
  if (remnant.snapshotPath) {
    if (!snapshot || snapshot.status !== 'valid') {
      return { status: 'not-replayable' }
    }
    const validSnapshot = snapshot.snapshot
    state = seedJournalFileFormatSnapshot(sessionId, validSnapshot)
    const tail = unionRows(validSnapshot.tail, rows.rows, validSnapshot.epoch)
    const oldest = tail[0]?.seq ?? validSnapshot.compactedThrough + 1
    if (
      findSequenceGap(
        tail.map((row) => row.seq),
        oldest
      ) ||
      oldest > validSnapshot.compactedThrough + 1
    ) {
      return { status: 'not-replayable' }
    }
    for (const row of tail) {
      if (row.seq > validSnapshot.compactedThrough) {
        applyJournalRow(state, row)
      }
    }
  } else {
    const epoch = rows.rows.at(-1)?.epoch
    if (!epoch) {
      return { status: 'not-replayable' }
    }
    const liveRows = rows.rows.filter((row) => row.epoch === epoch)
    const firstSequence = liveRows[0]?.seq
    if (
      firstSequence === undefined ||
      liveRows[0]?.kind !== 'epoch' ||
      findSequenceGap(
        liveRows.map((row) => row.seq),
        firstSequence
      )
    ) {
      return { status: 'not-replayable' }
    }
    state = createJournalReducerState(sessionId, epoch)
    for (const row of liveRows) {
      applyJournalRow(state, row)
    }
  }
  return state.items.size > MAX_RESTORED_ITEMS || !hasRestorableState(state)
    ? { status: 'not-replayable' }
    : { status: 'restored', state }
}

function hasRestorableState(state: JournalReducerState): boolean {
  return (
    state.items.size > 0 ||
    state.submissions.size > 0 ||
    state.receipts.size > 0 ||
    state.aliases.size > 0 ||
    state.tombstones.size > 0 ||
    state.appliedSettlementIds.size > 0
  )
}

async function fileSize(
  path: string
): Promise<{ path: string; bytes: number; fingerprint: string } | null> {
  try {
    const stats = await stat(path, { bigint: true })
    return {
      path,
      bytes: Number(stats.size),
      fingerprint: `${stats.size}:${stats.mtimeNs}`
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function readLogRows(
  path: string
): Promise<{ status: 'valid'; rows: JournalRow[] } | { status: 'not-replayable' }> {
  const rows: JournalRow[] = []
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({
    input,
    crlfDelay: Infinity
  })
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue
      }
      const parsed = parseJournalRow(line)
      if (!parsed.ok || rows.length >= MAX_REMNANT_ROWS) {
        return { status: 'not-replayable' }
      }
      rows.push(parsed.row)
    }
    return { status: 'valid', rows }
  } finally {
    lines.close()
    input.destroy()
  }
}

function unionRows(
  retained: readonly JournalRow[],
  live: readonly JournalRow[],
  epoch: string
): JournalRow[] {
  const rows = new Map<number, JournalRow>()
  for (const row of retained) {
    if (row.epoch === epoch) {
      rows.set(row.seq, row)
    }
  }
  for (const row of live) {
    if (row.epoch === epoch) {
      rows.set(row.seq, row)
    }
  }
  return [...rows.values()].sort((left, right) => left.seq - right.seq)
}

export const JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'journal-file-format-remnant'
}

export const JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID = agentJournalItemKey(
  JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY
)

export function journalFileFormatSourceWasDisclosed(state: JournalReducerState): boolean {
  return state.items.has(JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID)
}

export function journalFileFormatSourceNeedsCheck(
  state: JournalReducerState,
  retainsRestoredState: boolean
): boolean {
  const disclosure = state.items.get(JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID)
  if (disclosure?.body.kind !== 'status') {
    return false
  }
  if (retainsRestoredState || disclosure.body.text.startsWith('Restored ')) {
    return true
  }
  return (
    state.submissions.size === 0 &&
    state.items.size === 1 &&
    disclosure.body.text.startsWith("This chat's history")
  )
}

export type JournalFileFormatRemnantDisclosure = {
  identity: AgentJournalItemIdentity
  body: { kind: 'status'; text: string }
}

export function journalFileFormatRestoredDisclosure(input: {
  restored: number
}): JournalFileFormatRemnantDisclosure {
  const items = `${input.restored} item${input.restored === 1 ? '' : 's'}`
  return {
    identity: JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY,
    body: {
      kind: 'status',
      text: `Restored ${items} from this chat's history, which was saved in an older format`
    }
  }
}

export function journalFileFormatRemnantDisclosure(
  remnant: JournalFileFormatRemnant
): JournalFileFormatRemnantDisclosure {
  return {
    identity: JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY,
    body: {
      kind: 'status',
      text:
        `This chat's history was saved in an older format that this version could not read, ` +
        `so the session starts empty. The original transcript is still on disk at ` +
        `${remnant.transcriptPath}`
    }
  }
}
