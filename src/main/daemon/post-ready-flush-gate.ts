import type { PtySlaveLineEditorProbe } from '../../shared/pty-slave-line-discipline-echo'

export const POST_READY_FLUSH_DELAY_MS = 30
export const POST_READY_FLUSH_FALLBACK_MS = 200

export class PostReadyFlushGate {
  private awaitingPromptDraw = false
  private postDataTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null

  private generation = 0
  private probePending = false
  private probeDeadline = 0

  constructor(
    private readonly onFlush: () => void,
    private readonly lineEditorProbe?: PtySlaveLineEditorProbe
  ) {}

  private async flushWhenLineEditorReady(): Promise<void> {
    const generation = this.generation
    this.probePending = true
    const state = await this.lineEditorProbe?.().catch(() => 'unknown')
    if (generation !== this.generation) {
      return
    }
    this.probePending = false
    // Slow prompt hooks can leave cooked echo enabled long after the ready marker.
    if (state === 'other' && Date.now() < this.probeDeadline) {
      this.postDataTimer = setTimeout(() => {
        this.postDataTimer = null
        void this.flushWhenLineEditorReady()
      }, 250)
      return
    }
    this.onFlush()
  }

  private flush(): void {
    if (this.lineEditorProbe) {
      void this.flushWhenLineEditorReady()
    } else {
      this.onFlush()
    }
  }

  /** True between arm() and the actual flush firing. Callers should treat
   *  input as still-queued during this window to preserve ordering. */
  get isPending(): boolean {
    return (
      this.probePending ||
      this.awaitingPromptDraw ||
      this.postDataTimer !== null ||
      this.fallbackTimer !== null
    )
  }

  /** Arm the gate after observing the shell-ready marker. Starts the
   *  wall-clock fallback unless the marker scan already observed post-marker
   *  bytes, in which case the short post-data settle path is enough. */
  arm(postMarkerBytesObserved = false): void {
    this.probeDeadline = Date.now() + 15_000
    this.awaitingPromptDraw = true
    if (postMarkerBytesObserved) {
      this.notifyData()
      return
    }
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      this.awaitingPromptDraw = false
      this.flush()
    }, POST_READY_FLUSH_FALLBACK_MS)
  }

  /** Report a PTY data chunk observed after arm(). The first such call swaps
   *  the wall-clock fallback for the short post-data delay so readline has
   *  time to enable raw mode before the flush fires. */
  notifyData(): void {
    if (!this.awaitingPromptDraw) {
      return
    }
    this.awaitingPromptDraw = false
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    if (this.postDataTimer === null) {
      this.postDataTimer = setTimeout(() => {
        this.postDataTimer = null
        this.flush()
      }, POST_READY_FLUSH_DELAY_MS)
    }
  }

  /** Cancel any pending flush. Call on session teardown. */
  clear(): void {
    this.generation += 1
    this.probePending = false
    this.awaitingPromptDraw = false
    if (this.postDataTimer) {
      clearTimeout(this.postDataTimer)
      this.postDataTimer = null
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}
