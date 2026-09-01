import {
  FALLBACK_WINDOWS_EXECUTION_POLICY,
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  type WindowsExecutionPolicy
} from './windows-powershell-execution-policy'

/**
 * Consecutive child failures before the helper is believed dead, and how long
 * the one-shot bridge covers for it afterwards.
 *
 * Why not a latch: every plausible cause is transient — a Defender scan touching
 * the script mid-launch, a locked CSC temp directory failing one `Add-Type`,
 * momentary memory pressure. Giving up permanently silently restores the
 * per-click process burst the host exists to remove, and computer use keeps
 * working throughout, so nothing looks wrong while the MDE signature returns.
 */
export const MAX_START_ATTEMPTS = 3
export const START_FAILURE_COOLDOWN_MS = 60_000

/**
 * Whether the persistent helper is currently believed usable, and the execution
 * policy it should be started under.
 *
 * Split from the host so the recovery rules are readable on their own: they are
 * what stands between a transient bad spawn and a session that silently spends
 * the rest of its life on one powershell.exe per click.
 */
export class RuntimeHostAvailability {
  private policy: WindowsExecutionPolicy = PREFERRED_WINDOWS_EXECUTION_POLICY
  private retryUnderFallbackPolicy = false
  private consecutiveFailures = 0
  private consecutiveSuccesses = 0
  private cooldownUntil = 0

  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number,
    /** Public so the host can report its own start attempts to the same sink. */
    readonly warn: (message: string) => void
  ) {}

  get executionPolicy(): WindowsExecutionPolicy {
    return this.policy
  }

  get policyRetryPending(): boolean {
    return this.retryUnderFallbackPolicy
  }

  get atPreferredPolicy(): boolean {
    return this.policy === PREFERRED_WINDOWS_EXECUTION_POLICY
  }

  /** Milliseconds left before the host may try a helper again; 0 when it may. */
  remainingCooldown(): number {
    return Math.max(0, this.cooldownUntil - this.now())
  }

  requestPolicyRetry(): void {
    this.retryUnderFallbackPolicy = true
  }

  escalateExecutionPolicy(): void {
    this.retryUnderFallbackPolicy = false
    this.policy = FALLBACK_WINDOWS_EXECUTION_POLICY
    // Sticky for the session: a genuinely Restricted machine would otherwise pay
    // a guaranteed failed spawn per operation. Only a helper that produced no
    // output at all can reach here, so a snapshot cannot talk the host into it.
    this.warn(
      `runtime host start blocked at ${PREFERRED_WINDOWS_EXECUTION_POLICY}; using ${FALLBACK_WINDOWS_EXECUTION_POLICY} for the rest of this session`
    )
  }

  recordFailure(): void {
    this.consecutiveSuccesses = 0
    this.consecutiveFailures++
  }

  /** True once a helper has died often enough that respawning is just thrash. */
  get exhausted(): boolean {
    return this.consecutiveFailures >= MAX_START_ATTEMPTS
  }

  recordSuccess(): void {
    this.consecutiveSuccesses++
    // Why a clean run and not a single reply: a helper that answers one
    // operation and dies on the next would otherwise reset the count forever,
    // and respawn once per operation — the exact burst the host removes.
    if (this.consecutiveSuccesses >= MAX_START_ATTEMPTS) {
      this.consecutiveFailures = 0
    }
    if (this.cooldownUntil === 0) {
      return
    }
    this.cooldownUntil = 0
    this.warn('runtime host recovered; operations are served by the persistent helper again')
  }

  enterCooldown(): void {
    const failures = this.consecutiveFailures
    this.cooldownUntil = this.now() + this.cooldownMs
    // The wait is the penalty; leaving the count at the limit would charge twice
    // and let the first death after recovery re-enter a full cooldown, so an
    // interleaved workload would spend its life on the one-shot bridge.
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this.warn(
      `runtime host unavailable after ${failures} consecutive failures; falling back to one powershell.exe per operation for ${this.cooldownMs}ms`
    )
  }

  clearCooldown(): void {
    this.cooldownUntil = 0
  }
}
