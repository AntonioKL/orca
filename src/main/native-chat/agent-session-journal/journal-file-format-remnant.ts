// A journal directory left behind by the pre-SQLite file format, and the replay
// that brings it back.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript (a
// Codex rollout, a Claude session file). This is Orca's own journal — the
// `log.jsonl` the SQLite move stopped reading. The move changed the substrate,
// not the rows: every line is still a `JournalRow`, so `parseJournalRow`, the
// `v` upcast chain and the reducer all read it unchanged, and a restore is
// parse, fold, replace. Measured on real pre-move logs: 1119 of 1119 rows.
//
// A session found beside a remnant it cannot replay says so instead, because an
// empty chat that stays silent is indistinguishable from one created seconds ago.

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { parseJournalRow } from './journal-row-schema'

const FILE_FORMAT_LOG_FILE = 'log.jsonl'
const FILE_FORMAT_SNAPSHOT_FILE = 'snapshot.json'

/** Bounds on what one open will replay. A remnant past either is disclosed
 *  rather than restored: this read sits in front of the session's first paint. */
const MAX_REMNANT_BYTES = 64 * 1024 * 1024
const MAX_RESTORED_ITEMS = 20_000

export type JournalFileFormatRemnant = {
  /** The abandoned transcript, named so the history stays reachable by hand. */
  transcriptPath: string
  /** Only the append-only log replays. A snapshot holds folded reducer state,
   *  not rows, so it is disclosed and left alone. */
  kind: 'log' | 'snapshot'
}

/** The remnant in `journalDir`, or null when the directory never held one. */
export function findJournalFileFormatRemnant(journalDir: string): JournalFileFormatRemnant | null {
  const logPath = join(journalDir, FILE_FORMAT_LOG_FILE)
  if (existsSync(logPath)) {
    return { transcriptPath: logPath, kind: 'log' }
  }
  const snapshotPath = join(journalDir, FILE_FORMAT_SNAPSHOT_FILE)
  return existsSync(snapshotPath) ? { transcriptPath: snapshotPath, kind: 'snapshot' } : null
}

/** The remnant's live timeline, ready for `replaceEpochItems`. Empty whenever
 *  nothing could be replayed — an unreadable file, a bound, or a log holding no
 *  items — so the caller discloses instead. */
export async function readJournalFileFormatRemnantItems(
  remnant: JournalFileFormatRemnant,
  sessionId: string
): Promise<JournalReplacementItem[]> {
  if (remnant.kind !== 'log') {
    return []
  }
  const size = await stat(remnant.transcriptPath)
    .then((stats) => stats.size)
    .catch(() => null)
  if (size === null || size > MAX_REMNANT_BYTES) {
    return []
  }
  const contents = await readFile(remnant.transcriptPath, 'utf8').catch(() => null)
  if (contents === null) {
    return []
  }
  return foldFileFormatRows(contents, sessionId)
}

/** Fold the log the way replay folds a table. `applyJournalRow` ignores epoch
 *  rows — the SQLite replay scopes them with a WHERE clause — so supersession is
 *  this function's job: a later epoch discards everything before it. */
function foldFileFormatRows(contents: string, sessionId: string): JournalReplacementItem[] {
  let state = createJournalReducerState(sessionId, '')
  for (const line of contents.split('\n')) {
    if (line.trim().length === 0) {
      continue
    }
    const parsed = parseJournalRow(line)
    // Stop at the first row this build cannot read, exactly as replay does:
    // everything after it is unanchored.
    if (!parsed.ok) {
      break
    }
    if (parsed.row.kind === 'epoch') {
      state = createJournalReducerState(sessionId, parsed.row.epoch)
    }
    applyJournalRow(state, parsed.row)
  }
  const restored: JournalReplacementItem[] = []
  for (const item of [...state.items.values()].sort(
    (left, right) => left.sequence - right.sequence
  )) {
    const identity = parseAgentJournalItemKey(item.itemId)
    // A key that no longer parses cannot be upserted against later, so it is
    // dropped rather than restored under a fabricated identity.
    if (!identity) {
      continue
    }
    restored.push({ identity, body: item.body, observedAt: item.observedAt })
    if (restored.length >= MAX_RESTORED_ITEMS) {
      break
    }
  }
  return restored
}

/** One stable identity, so a reopen upserts the same row instead of adding one,
 *  and a later successful restore replaces the row that reported the failure. */
export const JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'journal-file-format-remnant'
}

export const JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID = agentJournalItemKey(
  JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY
)

export type JournalFileFormatRemnantDisclosure = {
  identity: AgentJournalItemIdentity
  body: { kind: 'status'; text: string }
}

/** Disclosed when the history came back. */
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

/** Disclosed when a session opens empty because its history could not be replayed. */
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
