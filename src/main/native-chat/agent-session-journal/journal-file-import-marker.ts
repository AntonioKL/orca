import type Database from '../../sqlite/sync-database'

const SELECT_IMPORT = 'SELECT source_fingerprint FROM journal_file_imports WHERE session_id = ?'
const UPSERT_IMPORT = `INSERT INTO journal_file_imports
  (session_id, source_fingerprint, attempted_at) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  source_fingerprint = excluded.source_fingerprint, attempted_at = excluded.attempted_at`
const DELETE_IMPORT = 'DELETE FROM journal_file_imports WHERE session_id = ?'

export function journalFileImportWasAttempted(
  db: Database.Database,
  sessionId: string,
  sourceFingerprint: string
): boolean {
  const row = db.prepare(SELECT_IMPORT).get(sessionId) as
    | { source_fingerprint?: string }
    | undefined
  return row?.source_fingerprint === sourceFingerprint
}

export function recordJournalFileImportAttempt(
  db: Database.Database,
  sessionId: string,
  sourceFingerprint: string,
  attemptedAt: number
): void {
  db.prepare(UPSERT_IMPORT).run(sessionId, sourceFingerprint, attemptedAt)
}

export function clearJournalFileImportAttempt(db: Database.Database, sessionId: string): void {
  db.prepare(DELETE_IMPORT).run(sessionId)
}
