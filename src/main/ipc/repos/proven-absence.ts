// Why anchored messages rather than `isENOENT`: over SSH the relay replaces a string errno with
// -32000 and forwards only the message (`relay/dispatcher-rpc-routing.ts`,
// `ssh/ssh-channel-multiplexer.ts`), so the message is the ONLY classification path remotely.
// Anchoring at the start stops a path that merely quotes an errno from matching.
const ENOENT_MESSAGE = /^ENOENT: no such file or directory\b/
const ENOTDIR_MESSAGE = /^ENOTDIR: not a directory\b/

// Why a vocabulary: only real errno names carry errno meaning. A wrapper attaching a domain string
// (`REMOTE_FS_ERROR`) while keeping the canonical message must not suppress the message fallback.
const AUTHORITATIVE_ERRNO = new Set(['ENOENT', 'ENOTDIR'])

/** Whether a failed probe proves the path is absent. Never throws. */
export function isProvenAbsent(error: unknown): boolean {
  const code = readErrnoCode(error)
  if (code !== undefined && AUTHORITATIVE_ERRNO.has(code)) {
    return code === 'ENOENT'
  }
  return ENOENT_MESSAGE.test(readMessage(error))
}

/**
 * Whether the probe proved the parent is not a directory — a definite answer about the target,
 * not an indeterminate probe, so callers should say so rather than "could not check".
 */
export function isNotADirectory(error: unknown): boolean {
  const code = readErrnoCode(error)
  if (code !== undefined && AUTHORITATIVE_ERRNO.has(code)) {
    return code === 'ENOTDIR'
  }
  return ENOTDIR_MESSAGE.test(readMessage(error))
}

// Why guarded: `?.` only protects a nullish base — it still invokes an accessor, so a throwing
// `code` getter would escape a fail-closed path as an unhandled rejection.
function readErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  try {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

function readMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  try {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}
