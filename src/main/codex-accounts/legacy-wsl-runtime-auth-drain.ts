import { createHash } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { runWslProcess } from '../wsl/wsl-runner'
import { compareCodexAuthFreshness, codexAuthIsFresher } from './codex-auth-identity'

const DRAIN_MARKER_NAME = 'direct-home-auth-drain-v1.json'
const MARKER_PRESENT_EXIT = 20
const SOURCE_AUTH_ABSENT_EXIT = 21

export type LegacyWslRuntimeAuthDestination = {
  authContents: string
  linuxHomePath: string
}

export type WslCodexAuthRead =
  | { kind: 'missing' | 'unreadable' }
  | { kind: 'present'; contents: string }

type LegacyWslRuntimeAuthDrainOptions = {
  distro: string
  guestHomeLinuxPath: string
  legacyPanePresent: boolean
  resolveDestination: (
    runtimeAuthContents: string
  ) => LegacyWslRuntimeAuthDestination | null | Promise<LegacyWslRuntimeAuthDestination | null>
}

const drainQueueByDistro = new Map<string, Promise<void>>()
const completedDistroKeys = new Set<string>()

export function startLegacyWslRuntimeAuthDrain(options: LegacyWslRuntimeAuthDrainOptions): void {
  const key = options.distro.trim().toLowerCase()
  if (completedDistroKeys.has(key)) {
    return
  }
  const previous = drainQueueByDistro.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if ((await drainLegacyWslRuntimeAuth(options)) === 'complete') {
        completedDistroKeys.add(key)
      }
    })
    .catch((error) => {
      console.warn('[codex-wsl-auth-drain] Failed to drain legacy runtime auth:', error)
    })
  drainQueueByDistro.set(key, next)
  void next.finally(() => {
    if (drainQueueByDistro.get(key) === next) {
      drainQueueByDistro.delete(key)
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
    if (!options.legacyPanePresent) {
      await finalizeAbsentLegacyAuth(options.distro, paths)
      return 'complete'
    }
    return 'pending'
  }
  assertSuccessfulDrainStep('inspect', inspection)

  const destination = await options.resolveDestination(inspection.stdout)
  if (!destination) {
    return 'pending'
  }
  const freshness = compareCodexAuthFreshness(inspection.stdout, destination.authContents)
  if (freshness === null) {
    return 'pending'
  }
  const promoteAuth = codexAuthIsFresher(inspection.stdout, destination.authContents)
  const result = await runWslProcess({
    distro: options.distro,
    loginPath: 'none',
    script: APPLY_LEGACY_AUTH_SCRIPT,
    args: [
      paths.runtimeHome,
      paths.activeHome,
      paths.marker,
      destination.linuxHomePath,
      sha256(inspection.stdout),
      sha256(destination.authContents),
      promoteAuth ? '1' : '0',
      options.legacyPanePresent ? '0' : '1'
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  assertSuccessfulDrainStep('apply', result)
  return options.legacyPanePresent ? 'pending' : 'complete'
}

export async function readWslCodexAuth(
  distro: string,
  linuxHomePath: string
): Promise<WslCodexAuthRead> {
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: READ_AUTH_SCRIPT,
    args: [linuxHomePath],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (result.code === SOURCE_AUTH_ABSENT_EXIT) {
    return { kind: 'missing' }
  }
  if (result.code !== 0 || result.timedOut) {
    return { kind: 'unreadable' }
  }
  return { kind: 'present', contents: result.stdout }
}

function resolveLegacyRuntimePaths(guestHomeLinuxPath: string): {
  activeHome: string
  marker: string
  runtimeHome: string
} {
  const runtimeHome = pathPosix.join(guestHomeLinuxPath, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS)
  const runtimeRoot = pathPosix.dirname(runtimeHome)
  return {
    activeHome: pathPosix.join(runtimeRoot, 'active', 'wsl', 'home'),
    marker: pathPosix.join(runtimeRoot, DRAIN_MARKER_NAME),
    runtimeHome
  }
}

async function finalizeAbsentLegacyAuth(
  distro: string,
  paths: ReturnType<typeof resolveLegacyRuntimePaths>
): Promise<void> {
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: FINALIZE_ABSENT_AUTH_SCRIPT,
    args: [paths.runtimeHome, paths.activeHome, paths.marker],
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  })
  assertSuccessfulDrainStep('finalize', result)
}

function assertSuccessfulDrainStep(
  step: string,
  result: { code: number | null; stderr: string; timedOut: boolean }
): void {
  if (result.code === 0 && !result.timedOut) {
    return
  }
  const detail = result.stderr.trim()
  throw new Error(
    `Legacy WSL auth drain ${step} failed (${result.timedOut ? 'timeout' : `exit ${result.code}`})${detail ? `: ${detail}` : ''}`
  )
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

const RESOLVE_LEGACY_HOME_SCRIPT = `
legacy_home="$1"
legacy_home_resolved=0
if [ -e "$1" ] || [ -L "$1" ]; then
  legacy_home=$(readlink -f -- "$1") || exit 30
  legacy_home_resolved=1
fi
if [ -e "$2" ] || [ -L "$2" ]; then
  active_home=$(readlink -f -- "$2") || exit 31
  if [ "$legacy_home_resolved" = 1 ]; then
    [ "$active_home" = "$legacy_home" ] || exit 32
  else
    legacy_home="$active_home"
  fi
fi
`

const INSPECT_LEGACY_AUTH_SCRIPT = `
set -eu
[ ! -f "$3" ] || exit ${MARKER_PRESENT_EXIT}
${RESOLVE_LEGACY_HOME_SCRIPT}
source_auth="$legacy_home/auth.json"
[ -f "$source_auth" ] || exit ${SOURCE_AUTH_ABSENT_EXIT}
cat -- "$source_auth"
`

const READ_AUTH_SCRIPT = `
set -eu
auth_path="$1/auth.json"
[ -f "$auth_path" ] || exit ${SOURCE_AUTH_ABSENT_EXIT}
cat -- "$auth_path"
`

const APPLY_LEGACY_AUTH_SCRIPT = `
set -eu
[ ! -f "$3" ] || exit 0
${RESOLVE_LEGACY_HOME_SCRIPT}
target_home=$(readlink -f -- "$4") || exit 33
[ "$legacy_home" != "$target_home" ] || exit 34
source_auth="$legacy_home/auth.json"
target_auth="$target_home/auth.json"
[ -f "$source_auth" ] || exit 35
[ -f "$target_auth" ] || exit 36
hash_file() { sha256sum -- "$1" | cut -d ' ' -f 1; }
[ "$(hash_file "$source_auth")" = "$5" ] || exit 37
[ "$(hash_file "$target_auth")" = "$6" ] || exit 38
umask 077
temporary_auth="$target_auth.orca-drain-$$"
temporary_credentials="$target_home/.credentials.json.orca-drain-$$"
temporary_marker="$3.orca-drain-$$"
cleanup() { rm -f -- "$temporary_auth" "$temporary_credentials" "$temporary_marker"; }
trap cleanup EXIT HUP INT TERM
source_credentials="$legacy_home/.credentials.json"
target_credentials="$target_home/.credentials.json"
if [ -f "$source_credentials" ] && [ ! -e "$target_credentials" ] && [ ! -L "$target_credentials" ]; then
  cp -- "$source_credentials" "$temporary_credentials"
  chmod 600 "$temporary_credentials"
  mv -n -- "$temporary_credentials" "$target_credentials"
fi
if [ "$7" = 1 ]; then
  cp -- "$source_auth" "$temporary_auth"
  chmod 600 "$temporary_auth"
  [ "$(hash_file "$target_auth")" = "$6" ] || exit 39
  mv -f -- "$temporary_auth" "$target_auth"
fi
if [ "$8" = 1 ]; then
  [ "$(hash_file "$source_auth")" = "$5" ] || exit 40
  rm -- "$source_auth"
  printf '%s\n' '{"completed":true}' > "$temporary_marker"
  chmod 600 "$temporary_marker"
  mv -f -- "$temporary_marker" "$3"
fi
`

const FINALIZE_ABSENT_AUTH_SCRIPT = `
set -eu
[ ! -f "$3" ] || exit 0
${RESOLVE_LEGACY_HOME_SCRIPT}
[ ! -e "$legacy_home/auth.json" ] && [ ! -L "$legacy_home/auth.json" ] || exit 41
umask 077
temporary_marker="$3.orca-drain-$$"
trap 'rm -f -- "$temporary_marker"' EXIT HUP INT TERM
printf '%s\n' '{"completed":true}' > "$temporary_marker"
chmod 600 "$temporary_marker"
mv -f -- "$temporary_marker" "$3"
`

export const _internals = {
  resetDrainQueue: (): void => {
    drainQueueByDistro.clear()
    completedDistroKeys.clear()
  }
}
