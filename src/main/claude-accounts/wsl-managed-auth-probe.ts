import { toWindowsWslPath } from '../wsl'
import type { WslResult } from '../wsl/wsl-runner'
import {
  MISSING_MANAGED_AUTH_MESSAGE,
  OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE,
  UNTRUSTED_MANAGED_AUTH_MESSAGE,
  type ClaudeManagedAuthVerdict
} from './claude-managed-auth-ownership'

/**
 * Why a tagged line instead of exit codes: under `set -e` a missing marker, a
 * marker for another account, a `readlink` failure, and `wsl.exe` failing to
 * start the distro all abort with the same status and empty stdout, so no exit
 * code is observable evidence of *which* happened. The guest instead states its
 * observation and exits 0; only a parsed tag is dispositive, and everything
 * else — no tag, extra output, non-zero exit, timeout, spawn failure — is
 * indeterminate. That inverts the old default under which a cold distro read as
 * "this is not your auth directory" (STA-5674).
 */
const VERDICT_TAG = 'ORCA_CLAUDE_AUTH_VERDICT:'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The canonical path is base64'd because it is interpolated into a line-oriented
 * protocol: a newline anywhere in `$HOME` would otherwise split the verdict in
 * two and read as a malformed probe.
 */
export function buildWslManagedAuthProbeScript(
  linuxPath: string,
  expectedAccountId?: string
): string {
  const markerTest = expectedAccountId
    ? `test "$contents" = ${shellQuote(expectedAccountId)}`
    : 'test -n "$contents"'
  return [
    'set -uo pipefail',
    `tag() { printf '${VERDICT_TAG}%s\\n' "$1"; exit 0; }`,
    `candidate=${shellQuote(linuxPath)}`,
    'managed_root="${HOME%/}/.local/share/orca/claude-accounts"',
    'candidate_real=$(readlink -f -- "$candidate") || exit 1',
    'managed_root_real=$(readlink -f -- "$managed_root") || exit 1',
    'marker="$candidate_real/.orca-managed-claude-auth"',
    'test -f "$marker" || tag missing-marker',
    'contents=$(cat -- "$marker") || exit 1',
    `${markerTest} || tag marker-mismatch`,
    'case "$candidate_real" in "$managed_root_real"/*/auth) ;; *) tag outside-managed-root ;; esac',
    "encoded=$(printf '%s' \"$candidate_real\" | base64 | tr -d '\\n') || exit 1",
    'tag "owned:$encoded"'
  ].join('\n')
}

function indeterminate(message: string, cause?: unknown): ClaudeManagedAuthVerdict {
  return { kind: 'indeterminate', error: new Error(message, cause ? { cause } : undefined) }
}

/** Base64 round-trips so a truncated or garbled payload cannot become a path. */
function decodeCanonicalPath(encoded: string): string | null {
  if (!encoded) {
    return null
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
  return decoded && Buffer.from(decoded, 'utf-8').toString('base64') === encoded ? decoded : null
}

export function classifyWslManagedAuthProbe(
  probe: WslResult,
  distro: string
): ClaudeManagedAuthVerdict {
  if (probe.timedOut) {
    return indeterminate('WSL Claude ownership probe timed out.')
  }
  if (!probe.environmentResolved) {
    return indeterminate('WSL Claude ownership probe could not resolve the distro environment.')
  }
  if (probe.code !== 0) {
    return indeterminate(`WSL Claude ownership probe exited with code ${String(probe.code)}.`)
  }
  const lines = probe.stdout
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const tagged = lines.filter((line) => line.startsWith(VERDICT_TAG))
  // The tag is the guest's last act, so anything after it means the run did not
  // end where the protocol says it ends.
  if (tagged.length !== 1 || lines.at(-1) !== tagged[0]) {
    return indeterminate('WSL Claude ownership probe did not report exactly one verdict.')
  }
  const value = tagged[0].slice(VERDICT_TAG.length)
  if (value === 'missing-marker') {
    return { kind: 'untrusted', reason: MISSING_MANAGED_AUTH_MESSAGE }
  }
  if (value === 'marker-mismatch') {
    return { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
  }
  if (value === 'outside-managed-root') {
    return { kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE }
  }
  if (!value.startsWith('owned:')) {
    return indeterminate('WSL Claude ownership probe reported an unknown verdict.')
  }
  const canonicalPath = decodeCanonicalPath(value.slice('owned:'.length))
  return canonicalPath
    ? { kind: 'owned', authPath: toWindowsWslPath(canonicalPath, distro) }
    : indeterminate('WSL Claude ownership probe reported an undecodable path.')
}
