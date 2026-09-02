import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { jumpToWorktreeFromSidebar } from '@/lib/worktree-jump-navigation'
import { useAppStore } from '@/store'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentPaneThread } from './activity-thread-types'

function getActivityThreadExecutionHostId(thread: AgentPaneThread) {
  return getWorktreeExecutionHostId(thread.worktree, thread.repo ?? undefined)
}

export function hasActivityThreadWorkspace(thread: AgentPaneThread): boolean {
  const state = useAppStore.getState()
  return Boolean(
    state.getKnownWorktreeById(thread.worktree.id, getActivityThreadExecutionHostId(thread))
  )
}

export function createActivityThreadActions({
  getMarkAllReadThreads,
  acknowledgeAgents,
  unacknowledgeAgents,
  setSelectedPaneKey
}: {
  /** Getter (not a snapshot) so the handlers keep one identity for the row memo
   *  bail-outs while bulk actions still see the current thread set. This is the
   *  badge-coherent set (child-filter only), not the search/scope-narrowed one,
   *  so Mark all read always drives the Agents badge to zero. */
  getMarkAllReadThreads: () => AgentPaneThread[]
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  setSelectedPaneKey: (paneKey: string | null) => void
}): {
  markThreadRead: (thread: AgentPaneThread) => void
  markThreadUnread: (thread: AgentPaneThread) => void
  selectThread: (thread: AgentPaneThread) => void
  jumpToWorkspace: (thread: AgentPaneThread) => void
  markAllThreadsRead: () => void
} {
  const markThreadRead = (thread: AgentPaneThread): void => {
    acknowledgeAgents([thread.paneKey])
  }

  const markThreadUnread = (thread: AgentPaneThread): void => {
    unacknowledgeAgents([thread.paneKey])
  }

  const activateThreadTerminal = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    const executionHostId = getActivityThreadExecutionHostId(thread)
    const worktree = state.getKnownWorktreeById(thread.worktree.id, executionHostId)
    if (!worktree) {
      return
    }
    // Why: retained-agent threads can outlive their tab; without a live tab, reorienting the workspace and focusing a dead tab id would just confuse the user.
    const liveTabs = state.tabsByWorktree[worktree.id] ?? []
    const hasLiveTab = liveTabs.some((t) => t.id === thread.tab.id)
    if (!hasLiveTab) {
      return
    }
    if (state.activeRepoId !== worktree.repoId) {
      state.setActiveRepo(worktree.repoId)
    }
    if (
      state.activeWorktreeId !== worktree.id ||
      state.activeWorkspaceExecutionHostId !== executionHostId
    ) {
      state.setActiveWorktree(worktree.id, executionHostId)
    }
    state.setActiveTabType('terminal')
    const parsed = parsePaneKey(thread.paneKey)
    activateTabAndFocusPane(
      thread.tab.id,
      parsed && parsed.tabId === thread.tab.id ? parsed.leafId : null,
      { flashFocusedPane: true, scrollToBottomIfOutputSinceLastView: true }
    )
  }

  const selectThread = (thread: AgentPaneThread): void => {
    setSelectedPaneKey(thread.paneKey)
    activateThreadTerminal(thread)
  }

  const jumpToWorkspace = (thread: AgentPaneThread): void => {
    if (!hasActivityThreadWorkspace(thread)) {
      return
    }
    markThreadRead(thread)
    jumpToWorktreeFromSidebar(thread.worktree.id, {
      executionHostId: getActivityThreadExecutionHostId(thread)
    })
  }

  const markAllThreadsRead = (): void => {
    const unreadKeys = getMarkAllReadThreads()
      .filter((t) => t.unread)
      .map((t) => t.paneKey)
    if (unreadKeys.length === 0) {
      return
    }
    acknowledgeAgents(unreadKeys)
  }

  return {
    markThreadRead,
    markThreadUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead
  }
}
