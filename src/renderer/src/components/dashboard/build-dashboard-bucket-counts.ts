import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  collectActiveDashboardWorkspaces,
  type ActiveDashboardWorkspace
} from './dashboard-snapshot-workspaces'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import {
  endWorktreeBucketCountPass,
  selectWorktreeBucketCounts
} from './dashboard-worktree-bucket-counts'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'

const EMPTY_COUNTS: Record<DashboardBucket, number> = {
  attention: 0,
  working: 0,
  done: 0,
  idle: 0
}

type ActiveWorkspacesCache = {
  repos: unknown
  worktreesByRepo: unknown
  folderWorkspaces: unknown
  projectGroups: unknown
  workspaces: ActiveDashboardWorkspace[]
}

let activeWorkspacesCache: ActiveWorkspacesCache | null = null

/**
 * `collectActiveDashboardWorkspaces` with `includeMapMetadata: false` reads only
 * these four slices, so the 400+ workspace descriptors it allocates can be
 * reused until one of them changes identity.
 */
function selectActiveDashboardWorkspaces(
  state: DashboardSnapshotState
): ActiveDashboardWorkspace[] {
  if (
    activeWorkspacesCache &&
    activeWorkspacesCache.repos === state.repos &&
    activeWorkspacesCache.worktreesByRepo === state.worktreesByRepo &&
    activeWorkspacesCache.folderWorkspaces === state.folderWorkspaces &&
    activeWorkspacesCache.projectGroups === state.projectGroups
  ) {
    return activeWorkspacesCache.workspaces
  }
  const workspaces = collectActiveDashboardWorkspaces(state, false)
  activeWorkspacesCache = {
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    workspaces
  }
  return workspaces
}

export function resetDashboardBucketCountCachesForTests(): void {
  activeWorkspacesCache = null
}

/** Derive sidebar counts without allocating dashboard cards or metadata. */
export function buildDashboardBucketCounts(
  state: DashboardSnapshotState,
  now: number
): Record<DashboardBucket, number> {
  const counts = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0
  } satisfies Record<DashboardBucket, number>
  const activeWorktrees = selectActiveDashboardWorkspaces(state)
  const { singletonOrchestration, orchestrationByWorktree } = selectDashboardOrchestration(
    state,
    activeWorktrees
  )

  for (const { worktree } of activeWorktrees) {
    const contribution = selectWorktreeBucketCounts(
      state,
      worktree.id,
      singletonOrchestration ??
        orchestrationByWorktree?.get(worktree.id) ??
        EMPTY_WORKTREE_AGENT_ORCHESTRATION,
      now
    )
    counts.attention += contribution.attention
    counts.working += contribution.working
    counts.done += contribution.done
    counts.idle += contribution.idle
  }
  endWorktreeBucketCountPass()

  return counts.attention === 0 && counts.working === 0 && counts.done === 0 && counts.idle === 0
    ? EMPTY_COUNTS
    : counts
}
