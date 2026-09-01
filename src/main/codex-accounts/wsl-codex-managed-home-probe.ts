import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { toWindowsWslPath } from '../wsl'
import {
  MARKER_NOT_REGULAR_FILE_MESSAGE,
  MISSING_MANAGED_HOME_MESSAGE,
  MISSING_OWNERSHIP_MARKER_MESSAGE,
  type HostCodexManagedHomeVerdict
} from './host-codex-managed-home-ownership'

/**
 * Why a tagged line instead of exit codes: under `set -e` an absent home, a
 * marker owned by another account, a `readlink` failure, and `wsl.exe` failing
 * to start a cold distro all abort with the same status and empty stdout, so no
 * exit code is observable evidence of *which* happened. The guest states its
 * observation and exits 0; only a parsed tag is dispositive, and everything else
 * — no tag, extra output, a throw from the runner, a timeout — is indeterminate.
 * That inverts the old default under which a cold distro read as "this home is
 * not Orca-owned" (STA-5616).
 */
const VERDICT_TAG = 'ORCA_CODEX_HOME_VERDICT:'

export const OUTSIDE_MANAGED_ROOT_MESSAGE =
  'Managed WSL Codex home is outside Orca account storage.'
export const ACCOUNT_ID_MISMATCH_MESSAGE =
  'Managed WSL Codex home does not match its persisted account ID.'
export const MARKER_ACCOUNT_MISMATCH_MESSAGE =
  'Managed WSL Codex home ownership marker does not match its account ID.'

/** What the host observed of the probe run itself, before any verdict parsing. */
export type WslCodexManagedHomeProbeOutcome =
  | { ran: true; stdout: string }
  | { ran: false; error: unknown }

/**
 * The canonical path is base64'd because it is interpolated into a
 * line-oriented protocol: a newline anywhere under `$HOME` would otherwise split
 * the verdict in two and read as a malformed probe.
 */
export function buildWslCodexManagedHomeProbeScript(
  linuxPath: string,
  expectedAccountId?: string
): string {
  return [
    'set -uo pipefail',
    `tag() { printf '${VERDICT_TAG}%s\\n' "$1"; exit 0; }`,
    // `test -e` returns the same status for "absent" and "cannot look" (EACCES on
    // a parent, EIO, ELOOP), so a bare `|| tag missing` would rebuild the very
    // collapse this probe exists to remove. Absence is only dispositive when the
    // parent can be listed AND the entry is not in it; every other shape exits
    // non-zero, which the host reads as indeterminate.
    'prove_absent() { ls -A -- "$1" >/dev/null 2>&1 || exit 1; ' +
      'ls -A -- "$1" 2>/dev/null | grep -Fxq -- "$2" && exit 1; tag "$3"; }',
    `candidate=${quotePosixShell(linuxPath)}`,
    'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
    'candidate_parent=$(dirname -- "$candidate") || exit 1',
    'candidate_name=$(basename -- "$candidate") || exit 1',
    'test -e "$candidate" || prove_absent "$candidate_parent" "$candidate_name" missing-home',
    'candidate_real=$(readlink -f -- "$candidate") || exit 1',
    'managed_root_real=$(readlink -f -- "$managed_root") || exit 1',
    'marker="$candidate_real/.orca-managed-home"',
    // lstat before stat, mirroring the host lane: a symlink marker is not
    // ownership proof however trustworthy the file it points at looks.
    'test -h "$marker" && tag marker-not-regular',
    'test -e "$marker" || prove_absent "$candidate_real" .orca-managed-home missing-marker',
    'test -f "$marker" || tag marker-not-regular',
    'contents=$(cat -- "$marker") || exit 1',
    'case "$candidate_real" in "$managed_root_real"/*/home) ;; *) tag outside-managed-root ;; esac',
    ...(expectedAccountId === undefined
      ? ['test -n "$contents" || tag marker-mismatch']
      : [
          `expected_marker=${quotePosixShell(expectedAccountId)}`,
          'test "$candidate_real" = "$managed_root_real/$expected_marker/home" || tag account-mismatch',
          'test "$contents" = "$expected_marker" || tag marker-mismatch'
        ]),
    "encoded=$(printf '%s' \"$candidate_real\" | base64 | tr -d '\\n') || exit 1",
    'tag "owned:$encoded"'
  ].join('\n')
}

function indeterminate(message: string, cause?: unknown): HostCodexManagedHomeVerdict {
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

const UNTRUSTED_TAGS = new Map<string, string>([
  ['missing-home', MISSING_MANAGED_HOME_MESSAGE],
  ['missing-marker', MISSING_OWNERSHIP_MARKER_MESSAGE],
  ['marker-not-regular', MARKER_NOT_REGULAR_FILE_MESSAGE],
  ['marker-mismatch', MARKER_ACCOUNT_MISMATCH_MESSAGE],
  ['account-mismatch', ACCOUNT_ID_MISMATCH_MESSAGE],
  ['outside-managed-root', OUTSIDE_MANAGED_ROOT_MESSAGE]
])

export function classifyWslCodexManagedHomeProbe(
  outcome: WslCodexManagedHomeProbeOutcome,
  distro: string
): HostCodexManagedHomeVerdict {
  if (!outcome.ran) {
    return {
      kind: 'indeterminate',
      error: new Error('WSL Codex ownership probe could not run.', { cause: outcome.error })
    }
  }
  const lines = outcome.stdout
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const tagged = lines.filter((line) => line.startsWith(VERDICT_TAG))
  // The tag is the guest's last act, so anything after it means the run did not
  // end where the protocol says it ends.
  if (tagged.length !== 1 || lines.at(-1) !== tagged[0]) {
    return indeterminate('WSL Codex ownership probe did not report exactly one verdict.')
  }
  const value = tagged[0].slice(VERDICT_TAG.length)
  const untrustedReason = UNTRUSTED_TAGS.get(value)
  if (untrustedReason !== undefined) {
    return { kind: 'untrusted', reason: untrustedReason }
  }
  if (!value.startsWith('owned:')) {
    return indeterminate('WSL Codex ownership probe reported an unknown verdict.')
  }
  const canonicalPath = decodeCanonicalPath(value.slice('owned:'.length))
  return canonicalPath
    ? { kind: 'owned', homePath: toWindowsWslPath(canonicalPath, distro) }
    : indeterminate('WSL Codex ownership probe reported an undecodable path.')
}
