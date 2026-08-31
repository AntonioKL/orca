import type { PtyConnectionDeps } from './pty-connection-types'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'

/** Builds the mutable PTY dependency bag shared by every pane in one mount. */
export function createTerminalPanePtyDeps(args: {
  deps: UseTerminalPaneLifecycleDeps
  refs: TerminalPaneLifecycleRefs
  startupCwd: string
  startupWithSetupSplitWait: PtyConnectionDeps['startup']
  mountFollowsTerminalPark: boolean
  restoredPtyIdByLeafId: Record<string, string>
}): PtyConnectionDeps {
  const { deps, refs, startupCwd, startupWithSetupSplitWait, mountFollowsTerminalPark } = args
  return {
    tabId: deps.tabId,
    worktreeId: deps.worktreeId,
    cwd: startupCwd,
    startup: startupWithSetupSplitWait,
    mountFollowsTerminalPark,
    paneTransportsRef: deps.paneTransportsRef,
    paneMode2031Ref: deps.paneMode2031Ref,
    paneKittyKeyboardModesRef: deps.paneKittyKeyboardModesRef,
    paneLastThemeModeRef: deps.paneLastThemeModeRef,
    replayingPanesRef: deps.replayingPanesRef,
    restoredViewportBlankingPanesRef: refs.restoredViewportBlankingPanesRef,
    isActiveRef: deps.isActiveRef,
    isVisibleRef: deps.isVisibleRef,
    onPtyExitRef: deps.onPtyExitRef,
    onAgentExitedRef: deps.onAgentExitedRef,
    onPtyErrorRef: deps.onPtyErrorRef,
    onPaneProcessDied: deps.onPaneProcessDied,
    onPtyRecoveryStateRef: deps.onPtyRecoveryStateRef,
    clearTabPtyId: deps.clearTabPtyId,
    consumeSuppressedPtyExit: deps.consumeSuppressedPtyExit,
    isPtyShutdownPending: deps.isPtyShutdownPending,
    updateTabTitle: deps.updateTabTitle,
    setRuntimePaneTitle: deps.setRuntimePaneTitle,
    clearRuntimePaneTitle: deps.clearRuntimePaneTitle,
    updateTabPtyId: deps.updateTabPtyId,
    markWorktreeUnread: deps.markWorktreeUnread,
    markTerminalTabUnread: deps.markTerminalTabUnread,
    markTerminalPaneUnread: deps.markTerminalPaneUnread,
    clearWorktreeUnread: deps.clearWorktreeUnread,
    clearTerminalTabUnread: deps.clearTerminalTabUnread,
    clearTerminalPaneUnread: deps.clearTerminalPaneUnread,
    onShowSessionRestoredBanner: deps.onShowSessionRestoredBanner,
    dispatchNotification: deps.dispatchNotification,
    setCacheTimerStartedAt: deps.setCacheTimerStartedAt,
    syncPanePtyLayoutBinding: deps.syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding: deps.clearExitedPanePtyLayoutBinding,
    onStartupBound: deps.onStartupBound,
    deferPtyInput: (paneId, data, forward) => {
      const suppression =
        refs.httpLinkClickFallbackDisposablesRef.current.get(paneId)?.ptyMouseSuppression
      if (suppression) {
        suppression.handlePtyInput(data, forward)
      } else {
        forward(data)
      }
    },
    recordPaneMode2031Subscription: (paneId, mode) => {
      deps.paneMode2031Ref.current.set(paneId, true)
      deps.paneLastThemeModeRef.current.set(paneId, mode)
    },
    restoredPtyIdByLeafId: args.restoredPtyIdByLeafId
  }
}
