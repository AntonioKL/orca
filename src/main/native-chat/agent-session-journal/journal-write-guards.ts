// Guards an append clears before it becomes durable.
//
// All four refuse loudly rather than degrade: a silent drop here is a message
// missing from the transcript with nothing to explain it.

import type { JournalPayloadLimits } from './journal-payload-bounds'

export class AgentSessionJournalError extends Error {
  constructor(
    readonly code:
      | 'journal_read_only'
      | 'journal_stale_fence'
      | 'journal_bound_exceeded'
      | 'journal_rate_exceeded'
      | 'journal_closed',
    message: string
  ) {
    super(message)
    this.name = 'AgentSessionJournalError'
  }
}

/** A journal written by a newer schema is readable but never writable: this
 *  host cannot represent rows it does not understand. */
export function assertJournalWritable(readOnly: boolean, sessionId: string): void {
  if (readOnly) {
    throw new AgentSessionJournalError(
      'journal_read_only',
      `agent-session journal for ${sessionId} uses a newer schema; this host is read-only`
    )
  }
}

/** A write from a superseded owner is rejected outright — merging it would let
 *  two writers share one sequence space. */
export function assertJournalFence(fence: number, highestFence: number): void {
  if (fence < highestFence) {
    throw new AgentSessionJournalError(
      'journal_stale_fence',
      `fence ${fence} is behind the journal's ${highestFence}`
    )
  }
}

/** Total size and append rate for one session, bounding a runaway agent. */
export class JournalAppendBudget {
  private windowStart = 0
  private appendsInWindow = 0

  constructor(
    private readonly sessionId: string,
    private readonly limits: JournalPayloadLimits
  ) {}

  fork(): JournalAppendBudget {
    return new JournalAppendBudget(this.sessionId, this.limits)
  }

  get maxSessionBytes(): number {
    return this.limits.maxSessionBytes
  }

  get maxAppendsPerWindow(): number {
    return this.limits.maxAppendsPerWindow
  }

  /** Capture rate state so a speculative append can be rolled back safely. */
  checkpoint(): { windowStart: number; appendsInWindow: number } {
    return { windowStart: this.windowStart, appendsInWindow: this.appendsInWindow }
  }

  restore(checkpoint: { windowStart: number; appendsInWindow: number }): void {
    this.windowStart = checkpoint.windowStart
    this.appendsInWindow = checkpoint.appendsInWindow
  }

  /** `rowCostBytes` is the transaction's physical page charge, not the row's
   *  JSON length: under SQLite those are different numbers (§ physical quota). */
  wouldExceedSize(rowCostBytes: number, sizeBytes: number): boolean {
    return sizeBytes + rowCostBytes > this.limits.maxSessionBytes
  }

  assert(rowCostBytes: number, ts: number, sizeBytes: number): void {
    if (this.wouldExceedSize(rowCostBytes, sizeBytes)) {
      throw new AgentSessionJournalError(
        'journal_bound_exceeded',
        `agent-session journal for ${this.sessionId} reached its ${this.limits.maxSessionBytes}-byte bound`
      )
    }
    this.assertRate(ts)
  }

  /** Lifecycle capacity cannot bypass the session-wide append rate. */
  assertLifecycle(rowCostBytes: number, ts: number, sizeBytes: number): void {
    if (this.wouldExceedSize(rowCostBytes, sizeBytes)) {
      throw new AgentSessionJournalError(
        'journal_bound_exceeded',
        `agent-session journal for ${this.sessionId} reached its ${this.limits.maxSessionBytes}-byte bound`
      )
    }
    this.assertRate(ts)
  }

  /**
   * Consume a lifecycle row covered by a pre-reserved append slot. Reserved
   * rows still observe the physical quota, but do not spend ordinary window
   * rate headroom that may be needed by unrelated traffic.
   */
  assertReservedLifecycle(rowCostBytes: number, sizeBytes: number): void {
    if (this.wouldExceedSize(rowCostBytes, sizeBytes)) {
      throw new AgentSessionJournalError(
        'journal_bound_exceeded',
        `agent-session journal for ${this.sessionId} reached its ${this.limits.maxSessionBytes}-byte bound`
      )
    }
  }

  private assertRate(ts: number): void {
    let windowStart = this.windowStart
    let appendsInWindow = this.appendsInWindow
    if (ts - windowStart >= this.limits.appendWindowMs) {
      windowStart = ts
      appendsInWindow = 0
    }
    appendsInWindow += 1
    if (appendsInWindow > this.limits.maxAppendsPerWindow) {
      // A refusal must not consume a slot, so a later retry can succeed.
      throw new AgentSessionJournalError(
        'journal_rate_exceeded',
        `agent-session journal for ${this.sessionId} exceeded ${this.limits.maxAppendsPerWindow} appends per ${this.limits.appendWindowMs}ms`
      )
    }
    this.windowStart = windowStart
    this.appendsInWindow = appendsInWindow
  }
}
