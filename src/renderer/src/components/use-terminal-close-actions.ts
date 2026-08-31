import { useCallback } from 'react'
import { useAppStore } from '../store'
import { closeTerminalTab } from './terminal/terminal-tab-actions'
import { shouldDeferParkedPtyExitTabClose } from './terminal-pane/terminal-parked-tab-watchers'
import { destroyWorkspaceWebviews } from '../store/slices/browser-webview-cleanup'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'
import {
  getActiveWorktreeRuntimeEnvironmentId,
  isPinnedVisibleTab
} from './terminal-workspace-model'
import type { TerminalCreateController } from './use-terminal-create-actions'

export function useTerminalCloseActions(controller: TerminalCreateController) {
  const {
    closeBrowserTab,
    consumeSuppressedPtyExit,
    setActiveFile,
    setActiveTab,
    setActiveTabType,
    setActiveWorktree
  } = controller
  const handleCloseTab = useCallback((tabId: string) => {
    closeTerminalTab(tabId)
  }, [])

  const handleCloseBrowserTab = useCallback(
    (tabId: string) => {
      const state = useAppStore.getState()
      const owningWorktreeEntry = Object.entries(state.browserTabsByWorktree).find(
        ([, worktreeTabs]) => worktreeTabs.some((tab) => tab.id === tabId)
      )
      const owningWorktreeId = owningWorktreeEntry?.[0] ?? null
      if (!owningWorktreeId) {
        return
      }
      if (isPinnedVisibleTab(state, owningWorktreeId, tabId)) {
        return
      }
      const plan = closeBrowserWorkspaceTabOnHosts({
        state,
        worktreeId: owningWorktreeId,
        workspaceId: tabId,
        visibleTabId: tabId,
        focusedEnvironmentId: getActiveWorktreeRuntimeEnvironmentId(owningWorktreeId)
      })
      if (!plan.closesLocally) {
        if (plan.removesVisibleTab) {
          const mirroredTab = (state.unifiedTabsByWorktree[owningWorktreeId] ?? []).find(
            (candidate) => candidate.contentType === 'browser' && candidate.entityId === tabId
          )
          if (mirroredTab) {
            state.closeUnifiedTab(mirroredTab.id)
          }
        }
        return
      }
      const closeOptions = plan.localCloseReason ? { reason: plan.localCloseReason } : undefined
      const currentTabs = state.browserTabsByWorktree[owningWorktreeId] ?? []
      if (currentTabs.length <= 1) {
        const hasUnifiedEntry = Object.values(state.unifiedTabsByWorktree).some((tabs) =>
          tabs.some((tab) => tab.contentType === 'browser' && tab.entityId === tabId)
        )
        closeBrowserTab(tabId, closeOptions)
        // closeBrowserTab announces the MRU target before guest teardown can trigger bridge fallback.
        destroyWorkspaceWebviews(state.browserPagesByWorkspace, tabId)
        // Why: the fallback below answers "the user emptied this worktree". Unwinding a create
        // that never finished is not that, so it must leave the selection as the click found it.
        if (plan.localCloseReason === 'cleanup') {
          return
        }
        if (!hasUnifiedEntry && state.activeWorktreeId === owningWorktreeId) {
          const worktreeFile = state.openFiles.find((file) => file.worktreeId === owningWorktreeId)
          if (worktreeFile) {
            setActiveFile(worktreeFile.id)
            setActiveTabType('editor')
          } else {
            const terminalTab = (state.tabsByWorktree[owningWorktreeId] ?? [])[0]
            if (terminalTab) {
              setActiveTab(terminalTab.id)
              setActiveTabType('terminal')
            } else {
              setActiveWorktree(null)
            }
          }
        }
        return
      }
      closeBrowserTab(tabId, closeOptions)
      // closeBrowserTab announces the MRU target before guest teardown can trigger bridge fallback.
      destroyWorkspaceWebviews(state.browserPagesByWorkspace, tabId)
    },
    [
      closeBrowserTab,
      setActiveFile,
      setActiveTab,
      setActiveTabType,
      setActiveWorktree
    ]
  )

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string) => {
      if (consumeSuppressedPtyExit(ptyId) || shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
        return
      }
      closeTerminalTab(tabId, { reason: 'pty-exit', lifecyclePtyId: ptyId })
    },
    [consumeSuppressedPtyExit]
  )

  return { handleCloseTab, handleCloseBrowserTab, handlePtyExit }
}

export type TerminalCloseController = TerminalCreateController &
  ReturnType<typeof useTerminalCloseActions>
