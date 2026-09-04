// Byte bounds on the two values SQLite stores as keys.
//
// `session_id` and `epoch` are written into `journal_rows`, into the implicit
// index its composite primary key creates, and into `journal_sessions` — and
// neither appears in `row_json`. An unbounded key is therefore unbounded
// payload the physical charge cannot see, so the journal boundary refuses one
// and `journalTxnPhysicalCost` charges the maximum these admit.

import { AgentSessionJournalError } from './journal-write-guards'

export const JOURNAL_MAX_SESSION_ID_BYTES = 512
export const JOURNAL_MAX_EPOCH_BYTES = 128

/** One row's key copies: the table leaf cell and the primary-key index entry. */
export const JOURNAL_ROW_KEY_BYTES = 2 * (JOURNAL_MAX_SESSION_ID_BYTES + JOURNAL_MAX_EPOCH_BYTES)

export function assertJournalKeyBytes(input: { sessionId: string; epoch?: string }): void {
  assertKey('session id', input.sessionId, JOURNAL_MAX_SESSION_ID_BYTES, input.sessionId)
  if (input.epoch !== undefined) {
    assertKey('epoch', input.epoch, JOURNAL_MAX_EPOCH_BYTES, input.sessionId)
  }
}

function assertKey(label: string, value: string, maxBytes: number, sessionId: string): void {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > maxBytes) {
    throw new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal for ${sessionId} was given a ${bytes}-byte ${label}; the bound is ${maxBytes}`
    )
  }
}
