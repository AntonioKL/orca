import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'

const SELECT_IMPORT = `SELECT source_fingerprint, retains_restored_state, journal_epoch,
    journal_sequence
  FROM journal_file_imports WHERE session_id = ?`
const UPSERT_IMPORT = `INSERT INTO journal_file_imports
  (session_id, source_fingerprint, retains_restored_state, journal_epoch, journal_sequence,
    attempted_at) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  source_fingerprint = excluded.source_fingerprint,
  retains_restored_state = excluded.retains_restored_state,
  journal_epoch = excluded.journal_epoch,
  journal_sequence = excluded.journal_sequence,
  attempted_at = excluded.attempted_at`

export type JournalFileImportRecord = {
  sourceFingerprint: string
  retainsRestoredState: boolean
  journalCursor: AgentJournalCursor
}

export function readJournalFileImportRecord(
  db: Database.Database,
  sessionId: string
): JournalFileImportRecord | null {
  const row = db.prepare(SELECT_IMPORT).get(sessionId) as
    | {
        source_fingerprint?: string
        retains_restored_state?: number
        journal_epoch?: string
        journal_sequence?: number
      }
    | undefined
  return row?.source_fingerprint && row.journal_epoch && row.journal_sequence !== undefined
    ? {
        sourceFingerprint: row.source_fingerprint,
        retainsRestoredState: row.retains_restored_state === 1,
        journalCursor: { epoch: row.journal_epoch, sequence: row.journal_sequence }
      }
    : null
}

export function recordJournalFileImportAttempt(
  db: Database.Database,
  sessionId: string,
  sourceFingerprint: string,
  retainsRestoredState: boolean,
  journalCursor: AgentJournalCursor,
  attemptedAt: number
): void {
  db.prepare(UPSERT_IMPORT).run(
    sessionId,
    sourceFingerprint,
    Number(retainsRestoredState),
    journalCursor.epoch,
    journalCursor.sequence,
    attemptedAt
  )
}
