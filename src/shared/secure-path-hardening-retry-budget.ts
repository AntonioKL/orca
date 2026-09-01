import {
  SecurePathHardeningCache,
  type SecurePathHardeningCacheBounds
} from './secure-path-hardening-cache'
import { reportSecurePathHardening } from './secure-path-windows-acl'

type HardeningFailureRecord = { windowStartedAt: number; attempts: number }

/**
 * How often a path whose hardening keeps failing may be retried.
 *
 * Why a rate limit and not a lifetime cap: the env store re-hardens on the *read* path at ~2/s
 * (#4901), so retrying every failure is a permanent icacls-and-log storm on hosts where hardening
 * cannot work — FAT32/exFAT have no ACLs, and network paths, redirected profiles and restricted
 * tokens refuse. But a cap that never expires latches a *transient* failure: one AV scan or
 * momentary lock, and every later credential write in the session is unprotected, silently, on a
 * host where hardening would now succeed. So bound the retry *rate*, never the lifetime, and
 * announce both directions of the transition so a stuck host is diagnosable.
 */
const HARDENING_RETRY_WINDOW_MS = 60_000
const MAX_HARDENING_ATTEMPTS_PER_WINDOW = 3

let hardeningFailures: SecurePathHardeningCache<HardeningFailureRecord> | null = null

function failures(): SecurePathHardeningCache<HardeningFailureRecord> {
  if (!hardeningFailures) {
    throw new Error('secure path hardening retry budget used before it was configured')
  }
  return hardeningFailures
}

export function configureHardeningRetryBudget(bounds: SecurePathHardeningCacheBounds): void {
  hardeningFailures = new SecurePathHardeningCache<HardeningFailureRecord>(bounds)
}

export function mayAttemptHardening(targetPath: string): boolean {
  const failure = failures().get(targetPath)
  if (!failure) {
    return true
  }
  // A stale window always re-probes: recovery must never require a restart to be noticed.
  if (Date.now() - failure.windowStartedAt >= HARDENING_RETRY_WINDOW_MS) {
    return true
  }
  return failure.attempts < MAX_HARDENING_ATTEMPTS_PER_WINDOW
}

export function recordHardeningOutcome(targetPath: string, restricted: boolean): void {
  const previous = failures().get(targetPath)
  if (restricted) {
    failures().delete(targetPath)
    if (previous && previous.attempts >= MAX_HARDENING_ATTEMPTS_PER_WINDOW) {
      reportSecurePathHardening(
        targetPath,
        'recovered',
        'hardening succeeded again after being rate-limited'
      )
    }
    return
  }
  const now = Date.now()
  const staleWindow = !previous || now - previous.windowStartedAt >= HARDENING_RETRY_WINDOW_MS
  const attempts = staleWindow ? 1 : previous.attempts + 1
  failures().set(targetPath, {
    windowStartedAt: staleWindow ? now : previous.windowStartedAt,
    attempts
  })
  // Fires exactly once per window: further attempts inside it are refused before they run.
  if (attempts === MAX_HARDENING_ATTEMPTS_PER_WINDOW) {
    reportSecurePathHardening(
      targetPath,
      'throttled',
      `hardening failed ${attempts} times; retrying at most ${MAX_HARDENING_ATTEMPTS_PER_WINDOW} times per ${HARDENING_RETRY_WINDOW_MS / 1000}s until it succeeds`
    )
  }
}
