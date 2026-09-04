// What a repair tells the user it did.
//
// Rows a repair rejected are SET ASIDE, not destroyed, and saying so is the
// difference between "your history is gone" and "your history is not being
// shown". The identity is a constant because replay reads it back: an epoch
// holding nothing but its anchor and this row is a repair that has not been
// reconstructed yet, not a timeline.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'

/** One stable identity, so a reopen upserts the same row instead of adding one. */
export const JOURNAL_REPAIR_DISCLOSURE_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'journal-malformed-lines'
}

export const JOURNAL_REPAIR_DISCLOSURE_ITEM_ID = agentJournalItemKey(
  JOURNAL_REPAIR_DISCLOSURE_IDENTITY
)

export type JournalRepairDisclosure = {
  identity: AgentJournalItemIdentity
  body: { kind: 'status'; text: string }
}

/** Disclosed whenever a repair hid rows, whether or not any of them was the row
 *  that could not be read: a gap sets aside rows that are perfectly valid. */
export function journalRepairDisclosure(input: {
  malformedRows: number
  quarantinedRows: number
}): JournalRepairDisclosure {
  return {
    identity: JOURNAL_REPAIR_DISCLOSURE_IDENTITY,
    body: { kind: 'status', text: repairText(input) }
  }
}

function repairText(input: { malformedRows: number; quarantinedRows: number }): string {
  const preserved =
    input.quarantinedRows > 0
      ? `${input.quarantinedRows} row${input.quarantinedRows === 1 ? '' : 's'} after it were set aside and remain recoverable`
      : ''
  if (input.malformedRows > 0) {
    const lines = `${input.malformedRows} journal line${input.malformedRows === 1 ? '' : 's'}`
    return `${lines} could not be read${preserved ? `; ${preserved}` : ''}`
  }
  const rows = `${input.quarantinedRows} journal row${input.quarantinedRows === 1 ? '' : 's'}`
  const setAside = input.quarantinedRows === 1 ? 'was set aside' : 'were set aside'
  return `${rows} could not be anchored to this session and ${setAside}; they remain recoverable`
}
