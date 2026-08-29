export type WindowCloseAction = 'allow-confirmed' | 'bypass-gone' | 'request-confirmation'

export type WindowCloseState = {
  /** The renderer already replied to window:close-requested and called close(). */
  windowCloseConfirmed: boolean
  /** webContents emitted render-process-gone (the process is truly gone). */
  rendererProcessGone: boolean
  /** Electron reports the webContents as crashed (isCrashed()). */
  isRendererCrashed: boolean
}

/**
 * Decides how a native 'close' event should be handled.
 *
 * Why: a force-killed HUNG renderer must not be treated like a true crash. The
 * renderer-owned confirmation (dirty-file save, running-process, multi-session
 * guard) is only safe to bypass when the renderer is genuinely gone/crashed and
 * therefore cannot answer — bypassing it for a merely-unresponsive renderer is
 * what silently destroyed other sessions in #5787. An unresponsive-but-alive
 * renderer (rendererProcessGone=false, isRendererCrashed=false) still resolves
 * to 'request-confirmation' so the save guard runs. App-wide quit separately
 * bounds failure to acknowledge that request; ordinary window close does not.
 * A genuinely gone renderer still bypasses so the window stays closable
 * (#5144/#5314).
 */
export function resolveWindowCloseAction(state: WindowCloseState): WindowCloseAction {
  if (state.windowCloseConfirmed) {
    return 'allow-confirmed'
  }
  if (state.rendererProcessGone || state.isRendererCrashed) {
    return 'bypass-gone'
  }
  return 'request-confirmation'
}

/**
 * Whether the local PTYs this window owns keep running after the quit closing it.
 *
 * Why this gates the quit bypass: quit calls `killAllPty()` then `disconnectDaemon()`,
 * and `killAllPty` is a no-op once the daemon adapter is installed — the shells are
 * the daemon's children and it declines to retire while a session is live. With no
 * daemon adapter the same quit takes the foreground children down with the process,
 * which is the state the bypass was never conditional on.
 *
 * Only a definite yes may skip the warning. A missing getter (window built before the
 * daemon wiring exists) or a throwing one is an undetermined answer, and an
 * undetermined answer is not a yes.
 */
export function resolveLocalPtysSurviveQuit(
  getDaemonOwnsFreshPersistentPtys?: () => boolean
): boolean {
  if (!getDaemonOwnsFreshPersistentPtys) {
    return false
  }
  try {
    return getDaemonOwnsFreshPersistentPtys() === true
  } catch {
    return false
  }
}
