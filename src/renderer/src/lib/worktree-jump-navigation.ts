import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getVisibleWorktreeShortcutTargets } from '@/components/sidebar/visible-worktrees'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

function wasHiddenBySidebarFilters(worktreeId: string, executionHostId?: ExecutionHostId): boolean {
  const state = useAppStore.getState()
  // Some lightweight callers/tests provide only the activation slice of state.
  if (!state.worktreesByRepo || !sidebarHasActiveFilters(state)) {
    return false
  }

  return !getVisibleWorktreeShortcutTargets().some((target) => {
    if (target.id !== worktreeId) {
      return false
    }
    if (!executionHostId || !target.executionHostId) {
      return true
    }
    return (
      normalizeExecutionHostId(target.executionHostId) === normalizeExecutionHostId(executionHostId)
    )
  })
}

/** Navigate from a worktree reference in either sidebar back to the workspace surface. */
export function jumpToWorktreeFromSidebar(
  worktreeId: string,
  options?: { executionHostId?: ExecutionHostId }
): boolean {
  const state = useAppStore.getState()
  const hiddenByFilters = wasHiddenBySidebarFilters(worktreeId, options?.executionHostId)

  const activated = activateAndRevealWorktree(worktreeId, {
    ...(hiddenByFilters ? { revealInSidebar: false, clearSidebarFilters: false } : {}),
    ...(options?.executionHostId ? { executionHostId: options.executionHostId } : {})
  })
  if (activated === false) {
    return false
  }

  // The worktree list is the Spaces/Projects sidebar body; jump actions should always expose it.
  state.setSidebarBody?.('workspaces')

  if (hiddenByFilters) {
    toast.warning(
      translate(
        'auto.lib.worktreeJumpNavigation.filteredNotice',
        'This worktree is hidden by sidebar filters. The workspace was opened, but it is not shown in Spaces.'
      )
    )
  }
  return true
}
