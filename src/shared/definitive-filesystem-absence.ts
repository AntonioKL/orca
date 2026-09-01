/**
 * The single errno allowlist for "this path is definitively not there".
 *
 * `existsSync` returns `false` for `ENOENT` and for `EPERM`, `EACCES`, `EBUSY`,
 * `EIO`, `UNKNOWN` and every unrecognised code alike, and a `catch` returning a
 * default does the same. Callers that act on absence — deleting a mirror,
 * overwriting a config, clearing a credential — must be able to tell the two
 * apart, and they must all agree on where the line is, so this lives in one
 * place rather than being re-derived per lane.
 *
 * An unknown code is never absence. Mapping the unknown to a verdict is the
 * category error this predicate exists to prevent.
 */
export function isDefinitiveAbsence(error: unknown): boolean {
  const code = readErrnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The errno of a caught value, or null when there is not one to read.
 *
 * Why guarded: a caught value is whatever was thrown, and reading `.code` off it
 * can itself throw -- a partial error object, a proxy, a getter that rejects.
 * That throw would escape the classifier this module exists to keep total, and
 * a caller would see a raw failure on the exact path meant to fail closed.
 * An unreadable code is never a code.
 */
export function readErrnoCode(error: unknown): string | null {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return null
  }
  try {
    const code = (error as NodeJS.ErrnoException).code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}
