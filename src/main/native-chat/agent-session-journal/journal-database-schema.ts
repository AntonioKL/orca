// Table shape for one session's journal database.
//
// `journal_rows` is the append-only log; `journal_sessions` is the derived
// projection, upserted in the SAME transaction as every row insert so the live
// epoch and the rows that belong to it can never disagree.

/** DB shape version, carried in `PRAGMA user_version`. Independent of the row
 *  body version (`JournalRow.v`): a newer build can change either alone. */
export const JOURNAL_DB_SCHEMA_VERSION = 1

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
`
}
