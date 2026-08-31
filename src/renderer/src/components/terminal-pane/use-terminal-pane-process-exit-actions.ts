import { useCallback, useEffect } from 'react'
import { useAppStore } from '../../store'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { connectPanePty } from './pty-connection'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import type { PaneProcessExit, PtyConnectionDeps } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

/** Owns the restart/close actions for panes whose PTY process has exited. */
export function useTerminalPaneProcessExitActions(controller: TerminalPaneCloseController) {
  const {
    clearCodexRestartNotice,
    clearExitedPanePtyLayoutBinding,
    clearRuntimePaneTitle,
    clearTabPtyId,
    clearTerminalPaneUnread,
    clearTerminalTabUnread,
    clearWorktreeUnread,
    consumePendingCodexPaneRestart,
    cwd,
    dispatchNotification,
    executeClosePane,
    isActiveRef,
    isVisibleRef,
    markTerminalPaneUnread,
    markTerminalTabUnread,
    markWorktreeUnread,
    managerRef,
    onAgentExitedRef,
    onPtyErrorRef,
    onPtyExitRef,
    onPtyRecoveryStateRef,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    paneMode2031Ref,
    panePtyBindingsRef,
    paneTransportsRef,
    pendingCodexPaneRestartIds,
    replayingPanesRef,
    savedLayout,
    setCacheTimerStartedAt,
    setPaneProcessExitsByPaneId,
    setRuntimePaneTitle,
    setTerminalError,
    showRestoredSessionBanner,
    suppressPtyExit,
    syncPanePtyLayoutBinding,
    tabId,
    updateTabPtyId,
    updateTabTitle,
    worktreeId
  } = controller

  const handleRestartCodexPane = useCallback(
    (
      paneId: number,
      restartStartup: PtyConnectionDeps['startup'] = CODEX_ACCOUNT_RESTART_STARTUP
    ) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      const panePtyBinding = panePtyBindingsRef.current.get(paneId)
      const existingPtyId = transport?.getPtyId()
      if (existingPtyId) {
        suppressPtyExit(existingPtyId)
        clearCodexRestartNotice(existingPtyId)
        clearTabPtyId(tabId, existingPtyId)
      }
      panePtyBinding?.dispose()
      panePtyBindingsRef.current.delete(paneId)
      syncPanePtyLayoutBinding(paneId, null)
      transport?.destroy?.()
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)
      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: restartStartup,
        mountFollowsTerminalPark: false,
        paneTransportsRef,
        paneMode2031Ref,
        paneKittyKeyboardModesRef,
        paneLastThemeModeRef,
        replayingPanesRef,
        isActiveRef,
        isVisibleRef,
        onPtyExitRef,
        onAgentExitedRef,
        onPtyErrorRef,
        onPtyRecoveryStateRef,
        clearTabPtyId,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        isPtyShutdownPending: useAppStore.getState().isPtyShutdownPending,
        updateTabTitle,
        setRuntimePaneTitle,
        clearRuntimePaneTitle,
        updateTabPtyId,
        markWorktreeUnread,
        markTerminalTabUnread,
        markTerminalPaneUnread,
        clearWorktreeUnread,
        clearTerminalTabUnread,
        clearTerminalPaneUnread,
        onShowSessionRestoredBanner: showRestoredSessionBanner,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      manager.setActivePane(paneId, { focus: true })
    },
    [
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearRuntimePaneTitle,
      clearTabPtyId,
      clearTerminalPaneUnread,
      clearTerminalTabUnread,
      clearWorktreeUnread,
      cwd,
      dispatchNotification,
      isActiveRef,
      isVisibleRef,
      markWorktreeUnread,
      markTerminalTabUnread,
      markTerminalPaneUnread,
      managerRef,
      onAgentExitedRef,
      onPtyErrorRef,
      onPtyExitRef,
      onPtyRecoveryStateRef,
      paneKittyKeyboardModesRef,
      paneLastThemeModeRef,
      paneMode2031Ref,
      panePtyBindingsRef,
      paneTransportsRef,
      replayingPanesRef,
      setCacheTimerStartedAt,
      setRuntimePaneTitle,
      setTerminalError,
      showRestoredSessionBanner,
      suppressPtyExit,
      syncPanePtyLayoutBinding,
      tabId,
      updateTabPtyId,
      updateTabTitle,
      worktreeId
    ]
  )

  const clearPaneProcessExit = useCallback(
    (paneId: number) => {
      setPaneProcessExitsByPaneId((current) => {
        if (current[paneId] === undefined) {
          return current
        }
        const next = { ...current }
        delete next[paneId]
        return next
      })
    },
    [setPaneProcessExitsByPaneId]
  )

  const handleRestartExitedPane = useCallback(
    (processExit: PaneProcessExit) => {
      clearPaneProcessExit(processExit.paneId)
      handleRestartCodexPane(
        processExit.paneId,
        resolveTerminalProcessExitRestartStartup(processExit)
      )
    },
    [clearPaneProcessExit, handleRestartCodexPane]
  )

  const handleCloseExitedPane = useCallback(
    (paneId: number) => {
      clearPaneProcessExit(paneId)
      executeClosePane(paneId)
    },
    [clearPaneProcessExit, executeClosePane]
  )

  const panePtyLayoutBindings = savedLayout.ptyIdsByLeafId
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !pendingCodexPaneRestartIds[ptyId]) {
        continue
      }
      if (consumePendingCodexPaneRestart(ptyId)) {
        handleRestartCodexPane(pane.id)
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [
    consumePendingCodexPaneRestart,
    handleRestartCodexPane,
    panePtyLayoutBindings,
    pendingCodexPaneRestartIds
  ])

  return { handleRestartExitedPane, handleCloseExitedPane }
}

export type TerminalPaneProcessExitController = ReturnType<typeof useTerminalPaneProcessExitActions>
