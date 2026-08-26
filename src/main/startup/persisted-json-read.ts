import { readFileSync } from 'node:fs'

/**
 * Classified read of a small persisted JSON artifact.
 *
 * Why not just null: "the file is not there" and "this process could not read the file" are
 * opposite facts. Collapsed into one null, an unlucky read — a Defender sharing violation on
 * the file a launch published seconds ago — looks like an absent decision, and every caller
 * that deletes what it cannot parse then destroys intact evidence.
 */
export type PersistedJsonRead<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'invalid' }

/** Reads and validates `path`; `parse` returns null for content this build cannot use. */
export function readPersistedJson<T>(
  path: string,
  parse: (value: unknown) => T | null
): PersistedJsonRead<T> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    // Why: only ENOENT means nothing was ever recorded. EACCES/EBUSY (Windows sharing
    // violation, an ACL repair mid-flight) says nothing about the contents, so the caller
    // must leave the file alone rather than treat it as corrupt.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'invalid' }
  }
  const value = parse(parsed)
  return value === null ? { kind: 'invalid' } : { kind: 'ok', value }
}
