import { readFile } from 'node:fs/promises'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalRenderItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  isAdmissibleAgentJournalRenderItem,
  isAdmissibleAgentJournalSubmission
} from '../../../shared/agent-session-journal-schemas'
import {
  createJournalReducerState,
  rememberAppliedSettlementId,
  type JournalReducerState
} from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

export type JournalFileFormatSnapshot = {
  v: number
  epoch: string
  compactedThrough: number
  highestFence: number
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  receipts: {
    clientMessageId: string
    providerItemId: string
    epoch: string
    sequence: number
    acceptedAt: number
  }[]
  aliases: { providerItemId: string; itemId: string }[]
  tombstones?: { itemId: string; revision: number }[]
  appliedSettlementIds?: string[]
  tail: JournalRow[]
}

export type JournalFileFormatSnapshotRead =
  | { status: 'valid'; snapshot: JournalFileFormatSnapshot }
  | { status: 'invalid' | 'unreadable' }

export async function readJournalFileFormatSnapshot(
  path: string
): Promise<JournalFileFormatSnapshotRead> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: 'invalid' }
    }
    throw error
  }
  const version = snapshotSchemaVersion(parsed)
  if (version === null) {
    return { status: 'invalid' }
  }
  if (version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION) {
    return { status: 'unreadable' }
  }
  return isJournalFileFormatSnapshot(parsed)
    ? { status: 'valid', snapshot: parsed }
    : { status: 'invalid' }
}

export function seedJournalFileFormatSnapshot(
  sessionId: string,
  snapshot: JournalFileFormatSnapshot
): JournalReducerState {
  const state = createJournalReducerState(sessionId, snapshot.epoch)
  for (const item of snapshot.items) {
    state.items.set(item.itemId, item)
  }
  for (const submission of snapshot.submissions) {
    state.submissions.set(submission.clientMessageId, { ...submission })
  }
  for (const receipt of snapshot.receipts) {
    state.receipts.set(receipt.clientMessageId, {
      clientMessageId: receipt.clientMessageId,
      providerItemId: receipt.providerItemId,
      cursor: { epoch: receipt.epoch, sequence: receipt.sequence },
      acceptedAt: receipt.acceptedAt
    })
  }
  for (const alias of snapshot.aliases) {
    state.aliases.set(alias.providerItemId, alias.itemId)
  }
  for (const tombstone of snapshot.tombstones ?? []) {
    state.tombstones.set(tombstone.itemId, tombstone.revision)
  }
  for (const settlementId of snapshot.appliedSettlementIds ?? []) {
    rememberAppliedSettlementId(state, settlementId)
  }
  state.highestFence = snapshot.highestFence
  state.lastSequence = snapshot.compactedThrough
  state.oldestSequence = snapshot.compactedThrough + 1
  return state
}

function snapshotSchemaVersion(value: unknown): number | null {
  const snapshot = recordOf(value)
  const version = snapshot?.v
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : null
}

function isJournalFileFormatSnapshot(value: unknown): value is JournalFileFormatSnapshot {
  const snapshot = recordOf(value)
  return Boolean(
    snapshot &&
    typeof snapshot.v === 'number' &&
    typeof snapshot.epoch === 'string' &&
    snapshot.epoch.length > 0 &&
    Number.isInteger(snapshot.compactedThrough) &&
    (snapshot.compactedThrough as number) >= 0 &&
    Number.isInteger(snapshot.highestFence) &&
    arrayOf(snapshot.items, isAdmissibleAgentJournalRenderItem) &&
    arrayOf(snapshot.submissions, isAdmissibleAgentJournalSubmission) &&
    arrayOf(snapshot.receipts, isReceipt) &&
    arrayOf(snapshot.aliases, isAlias) &&
    (snapshot.tombstones === undefined || arrayOf(snapshot.tombstones, isTombstone)) &&
    (snapshot.appliedSettlementIds === undefined ||
      arrayOf(snapshot.appliedSettlementIds, (entry) => typeof entry === 'string')) &&
    arrayOf(snapshot.tail, (row) => parseJournalRow(JSON.stringify(row)).ok)
  )
}

function arrayOf(value: unknown, predicate: (entry: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(predicate)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isTombstone(value: unknown): boolean {
  const tombstone = recordOf(value)
  return Boolean(
    tombstone && typeof tombstone.itemId === 'string' && Number.isInteger(tombstone.revision)
  )
}

function isReceipt(value: unknown): boolean {
  const receipt = recordOf(value)
  return Boolean(
    receipt &&
    typeof receipt.clientMessageId === 'string' &&
    typeof receipt.providerItemId === 'string' &&
    typeof receipt.epoch === 'string' &&
    typeof receipt.sequence === 'number' &&
    typeof receipt.acceptedAt === 'number'
  )
}

function isAlias(value: unknown): boolean {
  const alias = recordOf(value)
  return Boolean(
    alias && typeof alias.providerItemId === 'string' && typeof alias.itemId === 'string'
  )
}
