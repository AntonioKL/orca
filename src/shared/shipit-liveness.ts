import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from './child-process/run-process'

/**
 * Whether Squirrel's installer is running for a bundle.
 *
 * Three states, not two. Failing to look is not the same as looking and seeing nothing: if `ps`
 * is denied, times out, or overflows, we know nothing about the installer. Collapsing that into
 * `exited` would let a caller delete installer state out from under a swap that is still
 * running — see docs/reference/ssh-execution-boundary.md, which fixes this exact vocabulary.
 */
export type ShipItLiveness = 'live' | 'unverifiable' | 'exited'

export function getShipItLivenessForBundle(bundlePath: string): ShipItLiveness {
  if (process.platform !== 'darwin') {
    return 'exited'
  }
  // Why canonicalise: a symlinked or relocated bundle path spells the same app differently, and
  // `ps` reports whatever path the installer was launched with.
  let resolvedBundlePath = bundlePath
  try {
    resolvedBundlePath = realpathSync(bundlePath)
  } catch {
    // Keep the caller's path when it cannot be resolved.
  }
  // Why the full path and not a bare name: a `ps` match on any command line *mentioning* the
  // bundle would count unrelated processes (a grep, an editor, this very check's own shell) and
  // hold the gate closed forever.
  const shipItPath = join(
    resolvedBundlePath,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Versions',
    'A',
    'Resources',
    'ShipIt'
  )
  try {
    const result = runProcessSync({
      program: '/bin/ps',
      args: ['-Ao', 'args='],
      timeoutMs: 2_000
    })
    if (result.code !== 0 || result.outputTruncated) {
      return 'unverifiable'
    }
    // Why argv[0] plus a boundary: anchoring to the start of the line matches a process actually
    // executing ShipIt rather than one that merely names it, and requiring the next character to
    // be a separator stops `.../ShipIt-other` from counting as `.../ShipIt`.
    const running = result.stdout.split('\n').some((line) => {
      const argv0Line = line.trimStart()
      if (!argv0Line.startsWith(shipItPath)) {
        return false
      }
      const next = argv0Line.charAt(shipItPath.length)
      return next === '' || next === ' '
    })
    return running ? 'live' : 'exited'
  } catch {
    return 'unverifiable'
  }
}

/** Destructive cleanup requires positive evidence of absence; uncertainty never qualifies. */
export function isShipItProvenExited(bundlePath: string): boolean {
  return getShipItLivenessForBundle(bundlePath) === 'exited'
}

/** True while the installer may still be working — live, or we could not tell. */
export function mayShipItBeRunning(bundlePath: string): boolean {
  return getShipItLivenessForBundle(bundlePath) !== 'exited'
}

/**
 * Is a process still running?
 *
 * Signal 0 tests existence without touching the process. Only ESRCH proves absence — EPERM means
 * it exists under another user, and anything unexpected reads as alive, because wrongly declaring
 * a writer gone is what makes a live install look finished.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}
