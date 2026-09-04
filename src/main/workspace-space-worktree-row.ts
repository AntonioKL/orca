import { posix, win32 } from 'node:path'
import type { Repo } from '../shared/repo-types'
import type { Worktree } from '../shared/worktree/types'
import type {
  WorkspaceSpaceRepoSummary,
  WorkspaceSpaceDirectoryScanResult,
  WorkspaceSpaceItem,
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'
import type { WorkspaceSpaceEntryScan } from '../shared/workspace-space-entry-traversal'
import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../shared/execution-host'

export function basenameWorkspaceFilesystemPath(pathValue: string): string {
  return looksLikeWindowsPath(pathValue) ? win32.basename(pathValue) : posix.basename(pathValue)
}

export function joinWorkspaceFilesystemPath(parent: string, child: string): string {
  return looksLikeWindowsPath(parent) ? win32.join(parent, child) : posix.join(parent, child)
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

export type WorkspaceSpaceRepoScanResult = {
  summary: WorkspaceSpaceRepoSummary
  worktrees: WorkspaceSpaceWorktree[]
}

/**
 * A repo that produced nothing measurable, with the reason. `executionHostId` is omitted when the
 * row names one that cannot be resolved — a summary must not claim a host the row never named.
 */
export function unmeasuredWorkspaceSpaceRepoResult(
  repo: Pick<Repo, 'id' | 'displayName' | 'path'>,
  executionHostId: ExecutionHostId | null,
  error: string
): WorkspaceSpaceRepoScanResult {
  return {
    worktrees: [],
    summary: {
      repoId: repo.id,
      ...(executionHostId ? { executionHostId } : {}),
      displayName: repo.displayName,
      path: repo.path,
      isRemote: executionHostId !== LOCAL_EXECUTION_HOST_ID,
      worktreeCount: 0,
      scannedWorktreeCount: 0,
      unavailableWorktreeCount: 1,
      totalSizeBytes: 0,
      reclaimableBytes: 0,
      error
    }
  }
}

export function toWorkspaceSpaceItem(stats: WorkspaceSpaceEntryScan): WorkspaceSpaceItem {
  return { name: stats.name, path: stats.path, kind: stats.kind, sizeBytes: stats.sizeBytes }
}

function createBaseWorktreeRow(repo: Repo, worktree: Worktree, scannedAt: number) {
  return {
    worktreeId: worktree.id,
    repoId: repo.id,
    executionHostId: getWorktreeExecutionHostId(worktree, repo),
    repoDisplayName: repo.displayName,
    repoPath: repo.path,
    displayName: worktree.displayName,
    path: worktree.path,
    branch: worktree.branch,
    isMainWorktree: worktree.isMainWorktree,
    isRemote: Boolean(repo.connectionId),
    isSparse: worktree.isSparse === true,
    canDelete: !worktree.isMainWorktree,
    lastActivityAt: worktree.lastActivityAt,
    scannedAt
  }
}

export function createUnavailableWorkspaceSpaceRow(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  status: Exclude<WorkspaceSpaceScanStatus, 'ok'>,
  error: string
): WorkspaceSpaceWorktree {
  return {
    ...createBaseWorktreeRow(repo, worktree, scannedAt),
    status,
    error,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

export function createScannedWorkspaceSpaceRow(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  scan: WorkspaceSpaceDirectoryScanResult
): WorkspaceSpaceWorktree {
  return {
    ...createBaseWorktreeRow(repo, worktree, scannedAt),
    status: 'ok',
    error: null,
    sizeBytes: scan.sizeBytes,
    reclaimableBytes: worktree.isMainWorktree ? 0 : scan.sizeBytes,
    skippedEntryCount: scan.skippedEntryCount,
    topLevelItems: scan.topLevelItems,
    omittedTopLevelItemCount: scan.omittedTopLevelItemCount,
    omittedTopLevelSizeBytes: scan.omittedTopLevelSizeBytes
  }
}
