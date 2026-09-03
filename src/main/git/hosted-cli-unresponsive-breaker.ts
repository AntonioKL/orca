/**
 * Global circuit breaker for a hosted-provider CLI (`gh`, `glab`) that never answers.
 *
 * Why: #18234. The reporter's `~/.local/bin/gh` is `exec mise x gh -- gh "$@"`.
 * When mise hands the inner bare `gh` a PATH that still resolves back to the
 * wrapper, the wrapper re-execs itself in place — one process, state `R`, one
 * core at 100%, forever. The deadline (#18239) and the process-group kill
 * (#18258) bound a single invocation; nothing bounded the *sequence*, so every
 * caller started a fresh 15-30s burn and the machine never got the core back.
 *
 * Two consecutive deadline kills mean the binary is wedged rather than the
 * network being slow, so stop spawning it until the backoff expires. A single
 * timeout stays a timeout: slow links and huge responses are real.
 *
 * Scoped by CLI and execution runtime (`gh:native`, `glab:wsl:<distro>`), not by
 * provider host — a wedged binary fails every host it is asked about, and a
 * wedged `gh` says nothing about `glab`.
 *
 * Lives under git/ with zero imports so the runner can consult it without an
 * import cycle (mirrors gh-rate-limit-breaker.ts).
 */

const DEADLINE_KILLS_BEFORE_BLOCK = 2
// Why escalating: a wrapper that re-execs itself is a configuration fault, not
// a transient one. Re-probing every minute forever would keep paying a full
// deadline of CPU for an answer that has not changed.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const
// Why bounded: one entry per runtime, and WSL distro names come from user input.
const MAX_ENTRIES = 64

type UnresponsiveState = {
  /** Deadline kills since the last time gh answered anything at all. */
  deadlineKills: number
  blockedUntilMs: number
}

const stateByScope = new Map<string, UnresponsiveState>()

/** Scope key for a resolved CLI command. Native and each WSL distro wedge independently. */
export function cliRuntimeScopeKey(cli: string, wslDistro?: string): string {
  return `${cli}:${wslDistro ? `wsl:${wslDistro.toLowerCase()}` : 'native'}`
}

function touch(scope: string, state: UnresponsiveState): void {
  // Why delete-then-set: Map preserves insertion order, so this makes the
  // eviction below drop the coldest runtime rather than an active one.
  stateByScope.delete(scope)
  stateByScope.set(scope, state)
  while (stateByScope.size > MAX_ENTRIES) {
    const oldest = stateByScope.keys().next().value
    if (oldest === undefined) {
      break
    }
    stateByScope.delete(oldest)
  }
}

/**
 * Record that gh was killed at its deadline without ever answering.
 *
 * Only call this for a deadline kill: an abort is the caller giving up, and a
 * non-zero exit means gh ran and had an opinion.
 */
export function recordCliDeadlineKill(scope: string, nowMs: number = Date.now()): void {
  const existing = stateByScope.get(scope)
  const deadlineKills = (existing?.deadlineKills ?? 0) + 1
  if (deadlineKills < DEADLINE_KILLS_BEFORE_BLOCK) {
    touch(scope, { deadlineKills, blockedUntilMs: 0 })
    return
  }
  const backoffIndex = Math.min(deadlineKills - DEADLINE_KILLS_BEFORE_BLOCK, BACKOFF_MS.length - 1)
  touch(scope, { deadlineKills, blockedUntilMs: nowMs + BACKOFF_MS[backoffIndex] })
}

/**
 * Record that gh answered — success or failure. Any answer proves the binary is
 * not wedged, so it closes the breaker and resets the escalation.
 */
export function recordCliResponded(scope: string): void {
  stateByScope.delete(scope)
}

export function getCliUnresponsiveBlockedUntilMs(
  scope: string,
  nowMs: number = Date.now()
): number | null {
  const state = stateByScope.get(scope)
  if (!state || state.blockedUntilMs <= nowMs) {
    return null
  }
  touch(scope, state)
  return state.blockedUntilMs
}

export function createCliUnresponsiveError(
  cli: string,
  blockedUntilMs: number,
  nowMs: number = Date.now()
): Error & { stderr: string; cliUnresponsiveBlocked: true } {
  const retryInSeconds = Math.max(1, Math.ceil((blockedUntilMs - nowMs) / 1000))
  const message =
    `${cli} did not respond to its last ${DEADLINE_KILLS_BEFORE_BLOCK} invocations and had to be ` +
    `killed at the deadline; pausing ${cli} for ~${retryInSeconds}s instead of spawning it again. ` +
    `If ${cli} on PATH is a wrapper script, check that it resolves the real binary (stablyai/orca#18234).`
  return Object.assign(new Error(message), {
    stderr: message,
    cliUnresponsiveBlocked: true as const
  })
}

/** @internal — test-only */
export function _resetCliUnresponsiveBreaker(): void {
  stateByScope.clear()
}
