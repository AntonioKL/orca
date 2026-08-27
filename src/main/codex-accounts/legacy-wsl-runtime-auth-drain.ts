import { createHash } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { runWslProcess } from '../wsl/wsl-runner'
import { compareCodexAuthFreshness, codexAuthIsFresher } from './codex-auth-identity'

const DRAIN_MARKER_NAME = 'direct-home-auth-drain-v1.json'
const MARKER_PRESENT_EXIT = 20
const SOURCE_AUTH_ABSENT_EXIT = 21

export type LegacyWslRuntimeAuthDestination = { authContents: string; linuxHomePath: string }
type Inspection = {
  authContents: string
  credentials: { kind: 'missing' } | { kind: 'present'; contents: string }
}
export type LegacyWslRuntimeAuthDrainOptions = {
  distro: string
  guestHomeLinuxPath: string
  legacyPanePresent: boolean
  resolveDestination: (
    authContents: string
  ) => LegacyWslRuntimeAuthDestination | null | Promise<LegacyWslRuntimeAuthDestination | null>
}

const inFlight = new Map<string, Promise<void>>()
const complete = new Set<string>()

export function startLegacyWslRuntimeAuthDrain(options: LegacyWslRuntimeAuthDrainOptions): void {
  const key = options.distro.trim().toLowerCase()
  if (complete.has(key) || inFlight.has(key)) {
    return
  }
  const task = drainLegacyWslRuntimeAuth(options)
    .then((status) => {
      if (status === 'complete') {
        complete.add(key)
      }
    })
    .catch((error) =>
      console.warn('[codex-wsl-auth-drain] Failed to drain legacy runtime auth:', error)
    )
  inFlight.set(key, task)
  void task.finally(() => {
    if (inFlight.get(key) === task) {
      inFlight.delete(key)
    }
  })
}

export async function drainLegacyWslRuntimeAuth(
  options: LegacyWslRuntimeAuthDrainOptions
): Promise<'complete' | 'pending'> {
  const paths = resolveLegacyRuntimePaths(options.guestHomeLinuxPath)
  const inspection = await runWslProcess({
    distro: options.distro,
    loginPath: 'none',
    script: INSPECT_LEGACY_AUTH_SCRIPT,
    args: [paths.runtimeHome, paths.activeHome, paths.marker],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (inspection.code === MARKER_PRESENT_EXIT) {
    return 'complete'
  }
  if (inspection.code === SOURCE_AUTH_ABSENT_EXIT) {
    return options.legacyPanePresent ? 'pending' : finalizeAbsentLegacyAuth(options.distro, paths)
  }
  assertSuccessfulDrainStep('inspect', inspection)
  const inspected = parseInspection(inspection.stdout)
  if (!inspected) {
    return 'pending'
  }
  const destination = await options.resolveDestination(inspected.authContents)
  if (!destination) {
    return 'pending'
  }
  const freshness = compareCodexAuthFreshness(inspected.authContents, destination.authContents)
  if (freshness === null) {
    return 'pending'
  }
  const result = await runWslProcess({
    distro: options.distro,
    loginPath: 'none',
    script: APPLY_LEGACY_AUTH_SCRIPT,
    args: [
      paths.runtimeHome,
      paths.activeHome,
      paths.marker,
      destination.linuxHomePath,
      sha256(inspected.authContents),
      sha256(destination.authContents),
      codexAuthIsFresher(inspected.authContents, destination.authContents) ? '1' : '0',
      options.legacyPanePresent ? '0' : '1',
      inspected.credentials.kind === 'present' ? sha256(inspected.credentials.contents) : 'missing'
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  assertSuccessfulDrainStep('apply', result)
  return options.legacyPanePresent ? 'pending' : 'complete'
}

function parseInspection(stdout: string): Inspection | null {
  const [authBase64, kind, credentialsBase64] = stdout.split('\n')
  const authContents = decode(authBase64 ?? '')
  if (authContents === null) {
    return null
  }
  if (kind === 'missing') {
    return { authContents, credentials: { kind: 'missing' } }
  }
  if (kind !== 'present') {
    return null
  }
  const contents = decode(credentialsBase64 ?? '')
  if (contents === null || !isJsonObject(contents)) {
    return null
  }
  return { authContents, credentials: { kind: 'present', contents } }
}

function decode(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return Buffer.from(decoded).toString('base64') === value.replace(/\n/g, '') ? decoded : null
  } catch {
    return null
  }
}
function isJsonObject(contents: string): boolean {
  try {
    const value = JSON.parse(contents) as unknown
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}
function resolveLegacyRuntimePaths(guestHomeLinuxPath: string) {
  const runtimeHome = pathPosix.join(guestHomeLinuxPath, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS)
  const root = pathPosix.dirname(runtimeHome)
  return {
    runtimeHome,
    activeHome: pathPosix.join(root, 'active', 'wsl', 'home'),
    marker: pathPosix.join(root, DRAIN_MARKER_NAME)
  }
}
async function finalizeAbsentLegacyAuth(
  distro: string,
  paths: ReturnType<typeof resolveLegacyRuntimePaths>
): Promise<'complete' | 'pending'> {
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: FINALIZE_ABSENT_AUTH_SCRIPT,
    args: [paths.runtimeHome, paths.activeHome, paths.marker],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  assertSuccessfulDrainStep('finalize', result)
  return 'complete'
}
function assertSuccessfulDrainStep(
  step: string,
  result: { code: number | null; stderr: string; timedOut: boolean }
): void {
  if (result.code === 0 && !result.timedOut) {
    return
  }
  throw new Error(
    `Legacy WSL auth drain ${step} failed (${result.timedOut ? 'timeout' : `exit ${result.code}`})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
  )
}
function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

const RESOLVE_LEGACY_HOME_SCRIPT = `
legacy_home="$1"
legacy_home_resolved=0
if [ -e "$1" ] || [ -L "$1" ]; then legacy_home=$(readlink -f -- "$1") || exit 30; legacy_home_resolved=1; fi
if [ -e "$2" ] || [ -L "$2" ]; then active_home=$(readlink -f -- "$2") || exit 31; if [ "$legacy_home_resolved" = 1 ]; then [ "$active_home" = "$legacy_home" ] || exit 32; else legacy_home="$active_home"; legacy_home_resolved=1; fi; fi
`
const INSPECT_LEGACY_AUTH_SCRIPT = `
set -eu
[ ! -f "$3" ] || exit ${MARKER_PRESENT_EXIT}
${RESOLVE_LEGACY_HOME_SCRIPT}
source_auth="$legacy_home/auth.json"
[ -f "$source_auth" ] || exit ${SOURCE_AUTH_ABSENT_EXIT}
encode_file() { base64 < "$1" | tr -d '\\n'; }
encode_file "$source_auth"; printf '\\n'
source_credentials="$legacy_home/.credentials.json"
if [ -f "$source_credentials" ]; then printf 'present\\n'; encode_file "$source_credentials"; printf '\\n'; elif [ ! -e "$source_credentials" ] && [ ! -L "$source_credentials" ]; then printf 'missing\\n\\n'; else exit 44; fi
`

// The destination pin is a hard link to the exact inode being validated. A
// concurrent in-place rewrite changes the pin; an atomic replacement breaks
// -ef. Either case aborts before source retirement, preserving credentials.
const APPLY_LEGACY_AUTH_SCRIPT = `
set -eu
[ ! -f "$3" ] || exit 0
${RESOLVE_LEGACY_HOME_SCRIPT}
target_home=$(readlink -f -- "$4") || exit 33
[ "$legacy_home" != "$target_home" ] || exit 34
source_auth="$legacy_home/auth.json"; target_auth="$target_home/auth.json"
[ -f "$source_auth" ] || exit 35; [ -f "$target_auth" ] || exit 36
hash_file() { sha256sum -- "$1" | cut -d ' ' -f 1; }
[ "$(hash_file "$source_auth")" = "$5" ] || exit 37
[ "$(hash_file "$target_auth")" = "$6" ] || exit 38
umask 077
temporary_auth="$target_auth.orca-drain-$$"; temporary_credentials="$target_home/.credentials.json.orca-drain-$$"; destination_pin="$target_auth.orca-drain-pin-$$"; temporary_marker="$3.orca-drain-$$"
cleanup() { rm -f -- "$temporary_auth" "$temporary_credentials" "$destination_pin" "$temporary_marker"; }
trap cleanup EXIT HUP INT TERM
source_credentials="$legacy_home/.credentials.json"; target_credentials="$target_home/.credentials.json"
if [ -f "$source_credentials" ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  [ "$9" != missing ] || exit 43; [ "$(hash_file "$source_credentials")" = "$9" ] || exit 43
  cp -- "$source_credentials" "$temporary_credentials"; chmod 600 "$temporary_credentials"; [ "$(hash_file "$temporary_credentials")" = "$9" ] || exit 43; [ "$(hash_file "$source_credentials")" = "$9" ] || exit 43; mv -n -- "$temporary_credentials" "$target_credentials"
elif [ "$9" = missing ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  [ ! -e "$source_credentials" ] && [ ! -L "$source_credentials" ] || exit 43
fi
if [ "$7" = 1 ]; then
  cp -- "$source_auth" "$temporary_auth"; chmod 600 "$temporary_auth"; [ "$(hash_file "$temporary_auth")" = "$5" ] || exit 42
  [ "$(hash_file "$target_auth")" = "$6" ] || exit 39
  mv -f -- "$temporary_auth" "$target_auth"
fi
ln -- "$target_auth" "$destination_pin"
expected_target_hash="$6"; [ "$7" != 1 ] || expected_target_hash="$5"
[ "$(hash_file "$destination_pin")" = "$expected_target_hash" ] || exit 45
[ "$target_auth" -ef "$destination_pin" ] || exit 45
if [ "$8" = 1 ]; then
  [ "$(hash_file "$destination_pin")" = "$expected_target_hash" ] || exit 45
  [ "$target_auth" -ef "$destination_pin" ] || exit 45
  [ "$(hash_file "$source_auth")" = "$5" ] || exit 40
  rm -- "$source_auth"
  printf '%s\\n' '{"completed":true}' > "$temporary_marker"; chmod 600 "$temporary_marker"; mv -f -- "$temporary_marker" "$3"
fi
`
const FINALIZE_ABSENT_AUTH_SCRIPT = `
set -eu
[ ! -f "$3" ] || exit 0
${RESOLVE_LEGACY_HOME_SCRIPT}
[ ! -e "$legacy_home/auth.json" ] && [ ! -L "$legacy_home/auth.json" ] || exit 41
umask 077; marker_parent=\${3%/*}; mkdir -p -- "$marker_parent"; temporary_marker="$3.orca-drain-$$"; trap 'rm -f -- "$temporary_marker"' EXIT HUP INT TERM; printf '%s\\n' '{"completed":true}' > "$temporary_marker"; chmod 600 "$temporary_marker"; mv -f -- "$temporary_marker" "$3"
`

export const _internals = {
  applyLegacyAuthScript: APPLY_LEGACY_AUTH_SCRIPT,
  inspectLegacyAuthScript: INSPECT_LEGACY_AUTH_SCRIPT,
  resetDrainQueue: (): void => {
    inFlight.clear()
    complete.clear()
  }
}
