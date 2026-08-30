/**
 * Coalesces per-pane Codex transcript wakeups onto one deadline timer.
 *
 * Each key still owns its own deadline and payload; only the timer that wakes
 * the process is shared. This keeps pane cancellation and ordering independent
 * while avoiding one live timer per pane.
 */
export class CodexSubagentPollScheduler<T> {
  private readonly entries = new Map<string, { value: T; dueAt: number }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDueAt: number | undefined

  constructor(
    private readonly delayMs: number,
    private readonly onDue: (key: string, value: T) => void
  ) {}

  schedule(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, { value, dueAt: Date.now() + this.delayMs })
    this.arm()
  }

  clear(key: string): void {
    if (!this.entries.delete(key)) {
      return
    }
    this.arm()
  }

  clearAll(): void {
    this.entries.clear()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.timerDueAt = undefined
    }
  }

  /** Number of pane wakeups currently waiting for a deadline. */
  get size(): number {
    return this.entries.size
  }

  private arm(): void {
    if (this.entries.size === 0) {
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
        this.timerDueAt = undefined
      }
      return
    }

    let nextDueAt = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      nextDueAt = Math.min(nextDueAt, entry.dueAt)
    }
    if (this.timer !== undefined && this.timerDueAt === nextDueAt) {
      return
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
    }
    this.timerDueAt = nextDueAt
    const timer = setTimeout(
      () => {
        this.timer = undefined
        this.timerDueAt = undefined
        this.flush()
      },
      Math.max(0, nextDueAt - Date.now())
    )
    this.timer = timer
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private flush(): void {
    const now = Date.now()
    try {
      // Find one entry at a time so a callback can clear a sibling that has
      // not fired yet, matching independent timer cancellation semantics.
      while (true) {
        let dueEntry: { key: string; value: T } | undefined
        for (const [key, entry] of this.entries) {
          if (entry.dueAt <= now) {
            dueEntry = { key, value: entry.value }
            break
          }
        }
        if (!dueEntry) {
          break
        }
        this.entries.delete(dueEntry.key)
        this.onDue(dueEntry.key, dueEntry.value)
      }
    } finally {
      // A callback may have scheduled, cleared, or replaced any key.
      this.arm()
    }
  }
}
