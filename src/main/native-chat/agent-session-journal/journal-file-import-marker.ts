import type Database from '../../sqlite/sync-database'

const SELECT_IMPORT = `SELECT source_fingerprint, retains_restored_state
  FROM journal_file_imports WHERE session_id = ?`
const UPSERT_IMPORT = `INSERT INTO journal_file_imports
  (session_id, source_fingerprint, retains_restored_state, attempted_at) VALUES (?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  source_fingerprint = excluded.source_fingerprint,
  retains_restored_state = excluded.retains_restored_state,
  attempted_at = excluded.attempted_at`

export type JournalFileImportRecord = {
  sourceFingerprint: string
  retainsRestoredState: boolean
}

export function readJournalFileImportRecord(
  db: Database.Database,
  sessionId: string
): JournalFileImportRecord | null {
  const row = db.prepare(SELECT_IMPORT).get(sessionId) as
    | { source_fingerprint?: string; retains_restored_state?: number }
    | undefined
  return row?.source_fingerprint
    ? {
        sourceFingerprint: row.source_fingerprint,
        retainsRestoredState: row.retains_restored_state === 1
      }
    : null
}

export function recordJournalFileImportAttempt(
  db: Database.Database,
  sessionId: string,
  sourceFingerprint: string,
  retainsRestoredState: boolean,
  attemptedAt: number
): void {
  db.prepare(UPSERT_IMPORT).run(
    sessionId,
    sourceFingerprint,
    Number(retainsRestoredState),
    attemptedAt
  )
}
