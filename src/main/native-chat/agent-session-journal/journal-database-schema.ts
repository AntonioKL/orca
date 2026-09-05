// Table shape for one session's journal database.
//
// `journal_rows` is the append-only log; `journal_sessions` is the derived
// projection, upserted in the SAME transaction as every row insert so the live
// epoch and the rows that belong to it can never disagree. `journal_repairs`
// carries at most one row per session: the standing demand for a rebuild a
// partial repair leaves behind (see journal-repair-marker.ts).

/** DB shape version, carried in `PRAGMA user_version`. Independent of the row
 *  body version (`JournalRow.v`): a newer build can change either alone.
 *  v2 added repair markers; v3 added file-import fingerprints. */
export const JOURNAL_DB_SCHEMA_VERSION = 3

export function createJournalTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_rows (
  session_id TEXT    NOT NULL,
  epoch      TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  row_json   TEXT    NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
);
CREATE TABLE IF NOT EXISTS journal_sessions (
  session_id TEXT PRIMARY KEY,
  epoch      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_repairs (
  session_id   TEXT PRIMARY KEY,
  epoch        TEXT    NOT NULL,
  content_from INTEGER NOT NULL,
  repaired_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_file_imports (
  session_id             TEXT PRIMARY KEY,
  source_fingerprint     TEXT    NOT NULL,
  retains_restored_state INTEGER NOT NULL CHECK (retains_restored_state IN (0, 1)),
  journal_epoch          TEXT    NOT NULL,
  journal_sequence       INTEGER NOT NULL,
  attempted_at           INTEGER NOT NULL
);
`
}
