/**
 * Paces the wakes that inbound orchestration mail asks for.
 *
 * Two independent bounds, both caller-side — the mount door keeps no bookkeeping
 * of its own, mirroring the close-intent guard (`web-session-close-intent.ts`):
 *  - per-pane suppression, so a wake that fails (no window, record already gone)
 *    is not retried in a loop by the next message;
 *  - a minimum spacing between wakes, so one `@all` broadcast spreads its wakes
 *    instead of respawning a workspace at once. Queued wakes still happen.
 */

/** Mirrors the PTY wait `terminal.subscribe` allows a mount it just requested. */
export const SLEEPING_PANE_WAKE_MOUNT_SETTLE_MS = 10_000

/** Why derived: a wake is only observable once the pane has remounted AND its
 *  agent has cold-restored. Re-asking inside that window cannot learn anything
 *  new, so the TTL must outlast the mount wait plus the resume it triggers. */
const WAKE_RESUME_GRACE_MS = 20_000
export const SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS =
  SLEEPING_PANE_WAKE_MOUNT_SETTLE_MS + WAKE_RESUME_GRACE_MS

export const SLEEPING_PANE_WAKE_SPACING_MS = 1_500

/** Bounds a broadcast's queue; overflow stays durable mail, woken by the next arrival. */
export const SLEEPING_PANE_WAKE_QUEUE_LIMIT = 64

export type SleepingPaneWakeRequest = {
  paneKey: string
  worktreeId: string
  tabId?: string
  ptyId?: string
}

export type SleepingPaneWakeOutcome = 'requested' | 'queued' | 'suppressed' | 'dropped'

/** Node returns a Timeout, jsdom/browser a number; neither is unref-able for sure. */
type SleepingPaneWakeTimer = { unref?: () => void } | number

type SleepingPaneWakeSchedulerDependencies = {
  wake: (request: SleepingPaneWakeRequest) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => SleepingPaneWakeTimer
  cancel?: (timer: SleepingPaneWakeTimer) => void
}

export class SleepingPaneWakeScheduler {
  private readonly requestedAtByPaneKey = new Map<string, number>()
  private readonly queue = new Map<string, SleepingPaneWakeRequest>()
  private lastWakeAt = Number.NEGATIVE_INFINITY
  private drainTimer: SleepingPaneWakeTimer | null = null

  constructor(private readonly deps: SleepingPaneWakeSchedulerDependencies) {}

  request(request: SleepingPaneWakeRequest): SleepingPaneWakeOutcome {
    const now = this.now()
    this.pruneSuppressions(now)
    if (this.requestedAtByPaneKey.has(request.paneKey) || this.queue.has(request.paneKey)) {
      return 'suppressed'
    }
    if (now - this.lastWakeAt >= SLEEPING_PANE_WAKE_SPACING_MS && this.queue.size === 0) {
      this.fire(request, now)
      return 'requested'
    }
    if (this.queue.size >= SLEEPING_PANE_WAKE_QUEUE_LIMIT) {
      return 'dropped'
    }
    this.queue.set(request.paneKey, request)
    this.scheduleDrain(now)
    return 'queued'
  }

  dispose(): void {
    if (this.drainTimer !== null) {
      ;(this.deps.cancel ?? clearTimeout)(this.drainTimer as ReturnType<typeof setTimeout>)
      this.drainTimer = null
    }
    this.queue.clear()
    this.requestedAtByPaneKey.clear()
  }

  private fire(request: SleepingPaneWakeRequest, now: number): void {
    // Stamp before the call: a wake that throws must still be suppressed, or a
    // chatty run retries it on every message.
    this.requestedAtByPaneKey.set(request.paneKey, now)
    this.lastWakeAt = now
    try {
      this.deps.wake(request)
    } catch {
      // The message stays durable; the tab-open path still delivers it.
    }
  }

  private scheduleDrain(now: number): void {
    if (this.drainTimer !== null) {
      return
    }
    const delay = Math.max(0, this.lastWakeAt + SLEEPING_PANE_WAKE_SPACING_MS - now)
    const timer = (this.deps.schedule ?? setTimeout)(() => {
      this.drainTimer = null
      this.drain()
    }, delay)
    this.drainTimer = timer
    if (typeof timer !== 'number') {
      timer.unref?.()
    }
  }

  private drain(): void {
    const now = this.now()
    this.pruneSuppressions(now)
    const next = this.queue.entries().next()
    if (next.done) {
      return
    }
    const [paneKey, request] = next.value
    this.queue.delete(paneKey)
    this.fire(request, now)
    if (this.queue.size > 0) {
      this.scheduleDrain(now)
    }
  }

  private pruneSuppressions(now: number): void {
    for (const [paneKey, requestedAt] of this.requestedAtByPaneKey) {
      if (now - requestedAt >= SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS) {
        this.requestedAtByPaneKey.delete(paneKey)
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
