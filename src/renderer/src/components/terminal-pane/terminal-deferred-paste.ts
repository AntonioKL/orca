import type {
  TerminalPasteExecutionReason,
  TerminalPasteExecutionResult,
  TerminalPasteSource,
  TerminalPasteTextOptions
} from './terminal-paste-model'

/** Long enough for a dictation/IME/clipboard-manager overlay to hand focus back,
 *  short enough that the payload can never land in a surprising place later. */
export const TERMINAL_DEFERRED_PASTE_TIMEOUT_MS = 2_000

export type DeferredTerminalPaste = {
  paneId: number
  leafId: string
  source: TerminalPasteSource
  text: string
  options?: TerminalPasteTextOptions
}

export type DeferredTerminalPasteQueue = {
  /** Holds one payload; a second defer replaces the first and restarts the deadline. */
  defer: (entry: DeferredTerminalPaste) => void
  /** Returns and clears the payload only when it belongs to this pane. */
  claim: (paneId: number, leafId: string) => DeferredTerminalPaste | null
  /** Drops the payload without firing the expiry callback; returns what was dropped. */
  cancel: () => DeferredTerminalPaste | null
  isPending: () => boolean
  dispose: () => void
}

type CreateDeferredTerminalPasteQueueArgs = {
  onExpire: (entry: DeferredTerminalPaste) => void
  timeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => number
  clearTimer?: (timerId: number) => void
}

export function createDeferredTerminalPasteQueue({
  onExpire,
  timeoutMs = TERMINAL_DEFERRED_PASTE_TIMEOUT_MS,
  setTimer = (callback, ms) => window.setTimeout(callback, ms),
  clearTimer = (timerId) => window.clearTimeout(timerId)
}: CreateDeferredTerminalPasteQueueArgs): DeferredTerminalPasteQueue {
  let pending: DeferredTerminalPaste | null = null
  let timerId: number | null = null

  const take = (): DeferredTerminalPaste | null => {
    const taken = pending
    pending = null
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
    return taken
  }

  return {
    defer: (entry) => {
      take()
      pending = entry
      timerId = setTimer(() => {
        timerId = null
        // Why: release the clipboard text before notifying, so a throwing
        // notifier cannot leave the payload retained past its deadline.
        const expired = pending
        pending = null
        if (expired) {
          onExpire(expired)
        }
      }, timeoutMs)
    },
    claim: (paneId, leafId) => {
      if (!pending || pending.paneId !== paneId || pending.leafId !== leafId) {
        return null
      }
      return take()
    },
    cancel: () => take(),
    isPending: () => pending !== null,
    dispose: () => {
      take()
    }
  }
}

/** A paste the focus guard stopped is only deferrable while its pane is still the
 *  live target and no other pane has taken focus — the case the guard exists for. */
export function isDeferrablePasteFocusCancellation({
  status,
  reason,
  targetMounted,
  focusMovedToOtherPane
}: {
  status: TerminalPasteExecutionResult['status']
  reason: TerminalPasteExecutionReason | undefined
  targetMounted: boolean
  focusMovedToOtherPane: boolean
}): boolean {
  return (
    status === 'cancelled' && reason === 'stale-target' && targetMounted && !focusMovedToOtherPane
  )
}

type DeferredPasteFocusPane = {
  id: number
  leafId: string
  container: { contains: (node: Node | null) => boolean }
}

export type DeferredPasteFocusResolution<TPane extends DeferredPasteFocusPane> =
  | { action: 'ignore' }
  | { action: 'deliver'; pane: TPane; entry: DeferredTerminalPaste }
  | { action: 'drop'; pane: TPane; entry: DeferredTerminalPaste | null }

/** Focus landing back inside the deferred pane delivers it; focus landing in a
 *  different pane drops it, because that is the wrong-target case the guard protects. */
export function resolveDeferredPasteFocusIn<TPane extends DeferredPasteFocusPane>({
  panes,
  focusedElement,
  queue
}: {
  panes: readonly TPane[]
  focusedElement: Node | null
  queue: DeferredTerminalPasteQueue
}): DeferredPasteFocusResolution<TPane> {
  if (!queue.isPending() || !focusedElement) {
    return { action: 'ignore' }
  }
  const pane = panes.find((candidate) => candidate.container.contains(focusedElement))
  if (!pane) {
    return { action: 'ignore' }
  }
  const entry = queue.claim(pane.id, pane.leafId)
  if (entry) {
    return { action: 'deliver', pane, entry }
  }
  return { action: 'drop', pane, entry: queue.cancel() }
}

/** True when focus currently sits in a pane other than the paste's own target. */
export function isFocusInsideOtherPane<TPane extends DeferredPasteFocusPane>({
  panes,
  paneId,
  focusedElement
}: {
  panes: readonly TPane[]
  paneId: number
  focusedElement: Node | null
}): boolean {
  if (!focusedElement) {
    return false
  }
  return panes.some(
    (candidate) => candidate.id !== paneId && candidate.container.contains(focusedElement)
  )
}

/** The pane's focusin handler: deliver the payload to its own pane, drop it when a
 *  different pane takes focus, and leave it pending for anything else. */
export function createDeferredPasteFocusInHandler<TPane extends DeferredPasteFocusPane>({
  queue,
  getPanes,
  getFocusedElement,
  deliver,
  onDropped
}: {
  queue: DeferredTerminalPasteQueue
  getPanes: () => readonly TPane[]
  getFocusedElement: () => Node | null
  deliver: (pane: TPane, entry: DeferredTerminalPaste) => void
  onDropped: (entry: DeferredTerminalPaste) => void
}): () => void {
  return () => {
    const resolution = resolveDeferredPasteFocusIn({
      panes: getPanes(),
      focusedElement: getFocusedElement(),
      queue
    })
    if (resolution.action === 'deliver') {
      deliver(resolution.pane, resolution.entry)
      return
    }
    if (resolution.action === 'drop' && resolution.entry) {
      onDropped(resolution.entry)
    }
  }
}
