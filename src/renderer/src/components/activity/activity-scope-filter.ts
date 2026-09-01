import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AgentPaneThread } from './activity-thread-types'

/** Host/project scope for the Agents activity surfaces. Persisted and separate
 *  from the workspace-nav filters; hosts `null` = all, repoIds empty = all. */
export type ActivityScopeFilter = {
  visibleHostIds: readonly ExecutionHostId[] | null
  filterRepoIds: readonly string[]
  defaultHostId: ExecutionHostId
}

/** Repo ids that still exist; stale persisted ids must not count as an active filter. */
export function resolveActivityScopeRepoIds(
  filterRepoIds: readonly string[],
  repoMap: ReadonlyMap<string, Repo>
): string[] {
  return filterRepoIds.filter((repoId) => repoMap.has(repoId))
}

export function threadMatchesActivityScope(
  thread: AgentPaneThread,
  scope: ActivityScopeFilter
): boolean {
  if (scope.visibleHostIds) {
    const hostId = getWorktreeExecutionHostId(
      thread.worktree,
      thread.repo ?? undefined,
      scope.defaultHostId
    )
    if (!scope.visibleHostIds.includes(hostId)) {
      return false
    }
  }
  // Why: repo-less terminal buckets have no project, so a project scope hides them.
  if (scope.filterRepoIds.length > 0) {
    if (!thread.repo || !scope.filterRepoIds.includes(thread.repo.id)) {
      return false
    }
  }
  return true
}
