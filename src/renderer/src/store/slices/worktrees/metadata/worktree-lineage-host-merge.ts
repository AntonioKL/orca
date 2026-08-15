import type { AppState } from '../../../types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { findWorktreeById, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { findRepoForHost } from '../../repo-host-identity'
import { reuseEqualRecordMap } from '../../repo-identity-reconcile'

export function getWorktreeHostId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
): ExecutionHostId | null {
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (worktree?.hostId) {
    return worktree.hostId
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const detected = state.detectedWorktreesByRepo[repoId]?.worktrees.find(
    (entry) => entry.id === worktreeId
  )
  if (detected?.hostId) {
    return detected.hostId
  }
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings })
  return repo ? getRepoExecutionHostId(repo) : null
}

export function mergeLineageForHost(
  state: Pick<
    AppState,
    'repos' | 'settings' | 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'worktreeLineageById'
  >,
  hostId: ExecutionHostId,
  lineage: Readonly<Record<string, WorktreeLineage>>,
  idsAtRequestStart?: ReadonlySet<string>
): Readonly<Record<string, WorktreeLineage>> {
  const next: Record<string, WorktreeLineage> = {}
  for (const [worktreeId, existing] of Object.entries(state.worktreeLineageById)) {
    // Why: preserve an optimistic create write that landed after this request started.
    if (
      getWorktreeHostId(state, worktreeId) !== hostId ||
      (idsAtRequestStart !== undefined && !idsAtRequestStart.has(worktreeId))
    ) {
      next[worktreeId] = existing
    }
  }
  for (const [worktreeId, incoming] of Object.entries(lineage)) {
    next[worktreeId] = incoming
  }
  return reuseEqualRecordMap(state.worktreeLineageById, next)
}

export function mergeWorkspaceLineageForHost(
  state: Pick<
    AppState,
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
    | 'workspaceLineageByChildKey'
  >,
  hostId: ExecutionHostId,
  lineage: Readonly<Record<string, WorkspaceLineage>>,
  childKeysAtRequestStart?: ReadonlySet<string>
): Readonly<Record<string, WorkspaceLineage>> {
  const next: Record<string, WorkspaceLineage> = {}
  for (const [childKey, existing] of Object.entries(state.workspaceLineageByChildKey)) {
    const childScope = parseWorkspaceKey(existing.childWorkspaceKey)
    const childHostId =
      childScope?.type === 'worktree' ? getWorktreeHostId(state, childScope.worktreeId) : null
    // A focused host refresh can no longer prove unknown-host child rows are current.
    if (
      childScope?.type !== 'worktree' ||
      (childHostId !== null && childHostId !== hostId) ||
      (childKeysAtRequestStart !== undefined && !childKeysAtRequestStart.has(childKey))
    ) {
      next[childKey] = existing
    }
  }
  for (const [childKey, incoming] of Object.entries(lineage)) {
    next[childKey] = incoming
  }
  return reuseEqualRecordMap(state.workspaceLineageByChildKey, next)
}
