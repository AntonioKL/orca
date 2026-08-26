// Why: the director rate-limits /v1/assign per host at 5s, but every desktop
// retry path (coordinator full-jitter, drain full-jitter, reconcile() cancelling
// the Retry-After timer) can fire immediately, so hosts sit permanently limited.
// The gate lives below all of them, at the single call site that issues assigns.
const ASSIGN_MIN_INTERVAL_MS = 5_000
const ASSIGN_INTERVAL_JITTER_MS = 500

export class RelayAssignAbortedError extends Error {
  constructor() {
    super('relay_assignment_aborted_stale')
  }
}

export type RelayAssignRateGateOptions = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export function relayAssignRateKey(directorUrl: string, relayHostId: string): string {
  return `${directorUrl} ${relayHostId}`
}

export class RelayAssignRateGate {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly nextPermittedAt = new Map<string, number>()
  // Per-key promise chain: concurrent callers queue behind each other's booking
  // instead of stampeding out of one shared sleep.
  private readonly tails = new Map<string, Promise<void>>()

  constructor(options: RelayAssignRateGateOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

  get trackedKeyCount(): number {
    return this.nextPermittedAt.size
  }

  // Waits out the remaining interval for this host, then books the next slot.
  // Resolves only when the caller may send; throws if isCurrent went false while waiting.
  async reserve(key: string, isCurrent?: () => boolean): Promise<void> {
    const prior = this.tails.get(key)
    let release = (): void => {}
    const link = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prior ? prior.then(() => link) : link
    this.tails.set(key, tail)
    let stale = false
    try {
      await prior
      const waitMs = (this.nextPermittedAt.get(key) ?? 0) - this.now()
      if (waitMs > 0) {
        await this.sleep(waitMs)
      }
      // The wait widened the window between the caller's intent and the request;
      // a superseded caller must not spend the host's slot.
      stale = isCurrent ? !isCurrent() : false
      if (!stale) {
        this.book(key)
      }
      this.pruneExpired()
    } finally {
      release()
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    }
    if (stale) {
      throw new RelayAssignAbortedError()
    }
  }

  // Retry-After outlives the coordinator's armed timer, which reconcile() cancels.
  noteRetryAfter(key: string, retryAfterMs: number): void {
    if (retryAfterMs <= 0) {
      return
    }
    const until = this.now() + retryAfterMs
    if (until > (this.nextPermittedAt.get(key) ?? 0)) {
      this.nextPermittedAt.set(key, until)
    }
  }

  private book(key: string): void {
    const until =
      this.now() + ASSIGN_MIN_INTERVAL_MS + Math.floor(this.random() * ASSIGN_INTERVAL_JITTER_MS)
    if (until > (this.nextPermittedAt.get(key) ?? 0)) {
      this.nextPermittedAt.set(key, until)
    }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, until] of this.nextPermittedAt) {
      if (until <= now) {
        this.nextPermittedAt.delete(key)
      }
    }
  }
}

// Shared so every assign path — coordinator, drain recovery, any reconcile()
// bypass — books against the same per-host interval.
export const sharedRelayAssignRateGate = new RelayAssignRateGate()
