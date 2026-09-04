// Table shape for one session's journal database.
//
// `journal_rows` is the append-only log; `journal_sessions` is the derived
// projection, upserted in the SAME transaction as every row insert so the live
// epoch and the rows that belong to it can never disagree.
//
// `journal_quarantine` holds rows a repair rejected. It is written only by the
// suffix quarantine and read only for recovery, so nothing on the write or
// replay path ever joins against it.
//
// It is keyed on a surrogate `quarantine_id` rather than on `(session_id, epoch,
// seq)`, because a repair FREES the sequence numbers it removed and the live
// epoch reuses them: keying on the sequence would let a later repair overwrite
// what an earlier one preserved. `(epoch, seq)` stays as metadata, and the id
// orders the generations.

/** DB shape version, carried in `PRAGMA user_version`. Independent of the row
 *  body version (`JournalRow.v`): a newer build can change either alone. */
export const JOURNAL_DB_SCHEMA_VERSION = 2

/** Where the v1 sequence-keyed quarantine is parked at migration. Its rows are
 *  NOT copied forward: a quarantine holds whole rejected rows and can be
 *  megabytes, and duplicating it inside one transaction doubled the database
 *  past the physical bound that is supposed to be unbreachable. The table is
 *  renamed, frozen and read alongside the surrogate-keyed one instead. */
export const LEGACY_QUARANTINE_TABLE = 'journal_quarantine_v1'

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
CREATE TABLE IF NOT EXISTS journal_quarantine (
  quarantine_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT    NOT NULL,
  epoch          TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  row_json       TEXT    NOT NULL,
  quarantined_at INTEGER NOT NULL
);
`
}
