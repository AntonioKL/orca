import { isENOENT } from '../filesystem-path-containment'

/**
 * Whether a failed existence probe proves the path is absent.
 *
 * Why not `isENOENT` alone: its message fallback is unanchored, so an `EACCES` whose *path*
 * happens to contain "ENOENT: no such file or directory" would read as absent. A string `code` is
 * a definitive errno and settles the question by itself. Only when there is no string code — the
 * SSH relay replaces string errnos with a numeric one — do we fall back to the message.
 */
export function isProvenAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string') {
    return code === 'ENOENT'
  }
  return isENOENT(error)
}
