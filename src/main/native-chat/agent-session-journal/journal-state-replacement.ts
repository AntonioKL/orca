import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalDispatchState,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session-journal-schemas'
import type Database from '../../sqlite/sync-database'
import { JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID } from './journal-file-format-remnant'
import { clearJournalRepairMarker } from './journal-repair-marker'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import { journalRowBase } from './journal-row-builders'
import {
  deleteAllJournalRows,
  insertJournalRow,
  upsertJournalSessionRow
} from './journal-row-table'
import type { JournalLoad } from './journal-open'
import type { JournalRow } from './journal-row-schema'

const DISPATCH_STATES = new Set<AgentJournalDispatchState>([
  'pending',
  'accepted',
  'rejected',
  'unknown'
])
const HIDDEN_SUBMISSION_BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: []
}

export class JournalFileFormatStateInvalidError extends Error {}

export function replaceJournalEpochState(input: {
  db: Database.Database
  identity: AgentSessionJournalIdentity
  state: JournalReducerState
  now: () => number
  mintEpoch: () => string
  onPublished: (loaded: JournalLoad) => void
}): void {
  const epoch = input.mintEpoch()
  const rows = materializeStateRows(input.identity, input.state, epoch, input.now)
  const restored = replayReplacementRows(input.identity.sessionId, epoch, rows)
  assertEquivalentState(input.state, restored)

  input.db.exec('BEGIN IMMEDIATE')
  try {
    deleteAllJournalRows(input.db)
    clearJournalRepairMarker(input.db, input.identity.sessionId)
    for (const row of rows) {
      insertJournalRow(input.db, input.identity.sessionId, row)
    }
    upsertJournalSessionRow(input.db, input.identity.sessionId, epoch, rows[0]?.ts ?? input.now())
    input.db.exec('COMMIT')
  } catch (error) {
    input.db.exec('ROLLBACK')
    throw error
  }
  restored.oldestSequence = 1
  input.onPublished({ state: restored, readOnly: false, corrupt: false, malformedRows: 0 })
}

function materializeStateRows(
  identity: AgentSessionJournalIdentity,
  source: JournalReducerState,
  epoch: string,
  now: () => number
): JournalRow[] {
  const rows: JournalRow[] = [
    {
      kind: 'epoch',
      reason: 'legacy_import',
      providerHandle: identity.providerHandle,
      ...journalRowBase(epoch, 1, source.highestFence, now())
    }
  ]
  const submissions = new Map(source.submissions)
  const submissionsByItemId = new Map(
    [...source.submissions.keys()].map((clientMessageId) => [
      agentJournalSubmissionKey(clientMessageId),
      clientMessageId
    ])
  )
  for (const item of [...source.items.values()].sort(
    (left, right) => left.sequence - right.sequence
  )) {
    const clientMessageId = submissionsByItemId.get(item.itemId)
    if (clientMessageId) {
      const submission = submissions.get(clientMessageId)
      if (!submission || !isAdmissibleAgentJournalMessageBody(item.body)) {
        throw new JournalFileFormatStateInvalidError('legacy_journal_submission_state_invalid')
      }
      rows.push({
        kind: 'submission',
        clientMessageId,
        payloadFingerprint: submission.payloadFingerprint,
        providerHandle: identity.providerHandle,
        body: item.body,
        ...journalRowBase(epoch, rows.length + 1, submission.fence, submission.submittedAt)
      })
      submissions.delete(clientMessageId)
      if (item.revision > 0) {
        rows.push(itemRow(item, epoch, rows.length + 1, source.highestFence))
      }
      continue
    }
    rows.push(itemRow(item, epoch, rows.length + 1, source.highestFence))
  }
  for (const submission of submissions.values()) {
    const itemId = agentJournalSubmissionKey(submission.clientMessageId)
    if (!source.tombstones.has(itemId)) {
      throw new JournalFileFormatStateInvalidError('legacy_journal_submission_item_missing')
    }
    rows.push({
      kind: 'submission',
      clientMessageId: submission.clientMessageId,
      payloadFingerprint: submission.payloadFingerprint,
      providerHandle: identity.providerHandle,
      body: HIDDEN_SUBMISSION_BODY,
      ...journalRowBase(epoch, rows.length + 1, submission.fence, submission.submittedAt)
    })
  }
  appendDispatchRows(rows, source, epoch)
  for (const [itemId, revision] of source.tombstones) {
    rows.push({
      kind: 'tombstone',
      itemId,
      revision,
      ...journalRowBase(epoch, rows.length + 1, source.highestFence, now())
    })
  }
  appendSettlementRows(rows, source, epoch, now)
  return rows
}

function itemRow(
  item: AgentJournalRenderItem,
  epoch: string,
  seq: number,
  fence: number
): JournalRow {
  return {
    kind: 'item',
    itemId: item.itemId,
    revision: item.revision,
    body: item.body,
    ...journalRowBase(epoch, seq, fence, item.observedAt),
    ...(item.recovered ? { recovered: true as const } : {})
  }
}

function appendDispatchRows(rows: JournalRow[], source: JournalReducerState, epoch: string): void {
  const resolved = [...source.submissions.values()].sort(
    (left, right) => (left.resolvedAt ?? 0) - (right.resolvedAt ?? 0)
  )
  for (const submission of resolved) {
    if (submission.dispatchState === 'pending') {
      continue
    }
    if (!DISPATCH_STATES.has(submission.dispatchState) || submission.resolvedAt === null) {
      throw new JournalFileFormatStateInvalidError('legacy_journal_dispatch_state_invalid')
    }
    rows.push({
      kind: 'dispatch',
      clientMessageId: submission.clientMessageId,
      state: submission.dispatchState,
      providerItemId: submission.providerItemId,
      reason: submission.reason,
      ...journalRowBase(epoch, rows.length + 1, source.highestFence, submission.resolvedAt)
    })
  }
}

function appendSettlementRows(
  rows: JournalRow[],
  source: JournalReducerState,
  epoch: string,
  now: () => number
): void {
  for (const settlementId of source.appliedSettlementIds) {
    rows.push({
      kind: 'lifecycle-batch',
      settlementId,
      // The disclosure appended immediately after replacement removes this
      // zero-revision marker while each settlement identity remains durable.
      mutations: [
        {
          kind: 'tombstone',
          itemId: JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID,
          revision: 0
        }
      ],
      ...journalRowBase(epoch, rows.length + 1, source.highestFence, now())
    })
  }
}

function replayReplacementRows(sessionId: string, epoch: string, rows: readonly JournalRow[]) {
  const state = createJournalReducerState(sessionId, epoch)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

function assertEquivalentState(expected: JournalReducerState, actual: JournalReducerState): void {
  const sortedEntries = <T>(entries: Iterable<[string, T]>) =>
    [...entries].sort(([left], [right]) => left.localeCompare(right))
  const comparable = (state: JournalReducerState) => ({
    highestFence: state.highestFence,
    items: [...state.items.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((item) => ({ ...item, sequence: 0 })),
    tombstones: sortedEntries(state.tombstones).filter(
      ([itemId]) => itemId !== JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID
    ),
    submissions: sortedEntries(state.submissions),
    receipts: sortedEntries(state.receipts).map(([id, receipt]) => [
      id,
      { ...receipt, cursor: { epoch: '', sequence: 0 } }
    ]),
    aliases: sortedEntries(state.aliases),
    appliedSettlementIds: [...state.appliedSettlementIds]
  })
  if (JSON.stringify(comparable(expected)) !== JSON.stringify(comparable(actual))) {
    throw new JournalFileFormatStateInvalidError('legacy_journal_state_cannot_be_preserved')
  }
}
