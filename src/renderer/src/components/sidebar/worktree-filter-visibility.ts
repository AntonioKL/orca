import { useAppStore } from '@/store'
import { getRepoMapFromState } from '@/store/selectors'
import {
  buildVisibleWorktreeOptionsFromState,
  computeVisibleWorktreeIds
} from './visible-worktrees'

/**
 * Filter-only visibility for one worktree id: runs the sidebar filter pipeline
 * without collapse elision or rendered order, so a target inside a collapsed
 * group is not misreported as hidden by filters.
 */
export function worktreePassesSidebarFilters(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const repoMap = getRepoMapFromState(state)
  return computeVisibleWorktreeIds(
    state.worktreesByRepo,
    [],
    buildVisibleWorktreeOptionsFromState(state, repoMap)
  ).includes(worktreeId)
}
