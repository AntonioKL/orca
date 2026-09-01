import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import {
  MARKER_NOT_REGULAR_FILE_MESSAGE,
  MISSING_OWNERSHIP_MARKER_MESSAGE
} from './host-codex-managed-home-ownership'
import { MARKER_ACCOUNT_MISMATCH_MESSAGE } from './wsl-codex-managed-home-probe'

/**
 * Re-auth creates the managed home in the guest before the read probe gates it.
 * It runs as a separate script because it *writes*, and the exit codes below are
 * the only ones that may be read as a trust verdict — every other status is a
 * failure to determine, which the host maps to indeterminate (STA-5616).
 */
export const WSL_PREPARE_MARKER_MISSING_EXIT = 41
export const WSL_PREPARE_MARKER_MISMATCH_EXIT = 42
export const WSL_PREPARE_MARKER_NOT_REGULAR_EXIT = 43
/** Reserved so the guest can say "I could not tell" instead of guessing. */
export const WSL_PREPARE_INDETERMINATE_EXIT = 44

export const WSL_PREPARE_UNTRUSTED_EXITS = new Map<number, string>([
  [WSL_PREPARE_MARKER_MISSING_EXIT, MISSING_OWNERSHIP_MARKER_MESSAGE],
  [WSL_PREPARE_MARKER_MISMATCH_EXIT, MARKER_ACCOUNT_MISMATCH_MESSAGE],
  [WSL_PREPARE_MARKER_NOT_REGULAR_EXIT, MARKER_NOT_REGULAR_FILE_MESSAGE]
])

/**
 * Why the listing dance around a missing marker: `test -e` fails identically for
 * "not there" and "cannot look", so exiting 41 straight off it would report an
 * unreadable home as a foreign one — and re-auth refuses on 41. Absence is only
 * dispositive when the home can be listed and the marker is not in it.
 */
export function buildWslManagedHomePreparationScript(
  linuxPath: string,
  expectedAccountId: string
): string {
  return [
    'set -euo pipefail',
    `candidate=${quotePosixShell(linuxPath)}`,
    `expected_marker=${quotePosixShell(expectedAccountId)}`,
    'marker="$candidate/.orca-managed-home"',
    // lstat first: writing through a symlink would put the account id into
    // whatever the link points at, before any ownership check has run.
    `if [ -h "$marker" ]; then exit ${WSL_PREPARE_MARKER_NOT_REGULAR_EXIT}; fi`,
    'if [ -e "$candidate" ]; then',
    '  if [ ! -e "$marker" ]; then',
    `    ls -A -- "$candidate" >/dev/null 2>&1 || exit ${WSL_PREPARE_INDETERMINATE_EXIT}`,
    '    if ls -A -- "$candidate" 2>/dev/null | grep -Fxq -- .orca-managed-home; then',
    `      exit ${WSL_PREPARE_INDETERMINATE_EXIT}`,
    '    fi',
    `    exit ${WSL_PREPARE_MARKER_MISSING_EXIT}`,
    '  fi',
    `  if [ ! -f "$marker" ]; then exit ${WSL_PREPARE_MARKER_NOT_REGULAR_EXIT}; fi`,
    `  if [ "$(cat -- "$marker")" != "$expected_marker" ]; then exit ${WSL_PREPARE_MARKER_MISMATCH_EXIT}; fi`,
    'fi',
    'mkdir -p -- "$candidate"',
    `printf '%s\\n' "$expected_marker" > "$marker"`
  ].join('\n')
}
