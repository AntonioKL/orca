import { describeCreatedWorktree, listWorktreesSharedStrict } from '../git/worktree'
import type { GitWorktreeExecOptions } from '../git/worktree'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { areWorktreePathsEqual } from './worktree-path-comparison'

export function findCreatedWorktree<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  platform = process.platform
): T | undefined {
  const direct = worktrees.find((worktree) =>
    areWorktreePathsEqual(worktree.path, requestedPath, platform)
  )
  if (direct) {
    return direct
  }

  return worktrees.find((worktree) => worktree.branch === `refs/heads/${branchName}`)
}

export type CreatedWorktreeResolution = {
  created: GitWorktreeInfo
  /** Rows `git worktree list` returned; empty when only the direct read found the worktree. */
  worktrees: readonly GitWorktreeInfo[]
  /** Whether `worktrees` is the repo's whole listing, and so usable as its authorized-root set. */
  listingComplete: boolean
}

/** `created but not found in listing` is load-bearing for `classifyWorkspaceCreateError`. */
export function createdWorktreeNotFoundError(worktreePath: string, branchName: string): Error {
  return new Error(
    `Worktree created but not found in listing: ${worktreePath} (branch ${branchName})`
  )
}

/**
 * Find the row for a worktree `git worktree add` just created, preferring the repo listing and
 * falling back to asking Git about the worktree itself.
 *
 * Why the fallback: the listing was the only witness the old code had, so any Git-level listing
 * failure failed a create whose worktree and branch were already on disk, orphaning both (#16520).
 */
export async function resolveCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options?: GitWorktreeExecOptions
): Promise<CreatedWorktreeResolution> {
  let listingError: unknown
  try {
    const worktrees = options
      ? await listWorktreesSharedStrict(repoPath, options)
      : await listWorktreesSharedStrict(repoPath)
    const created = findCreatedWorktree(worktrees, worktreePath, branchName)
    if (created) {
      return { created, worktrees, listingComplete: true }
    }
  } catch (err) {
    listingError = err
  }

  let described: GitWorktreeInfo | undefined
  try {
    described = options
      ? await describeCreatedWorktree(repoPath, worktreePath, branchName, options)
      : await describeCreatedWorktree(repoPath, worktreePath, branchName)
  } catch {
    // Why swallow: the recovery must not replace the listing's own, more informative failure.
  }
  if (described) {
    return { created: described, worktrees: [], listingComplete: false }
  }
  throw listingError ?? createdWorktreeNotFoundError(worktreePath, branchName)
}
