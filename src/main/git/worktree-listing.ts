import { realpath, stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  readCheckedOutBranchRef,
  readRepoCommonDirFromGit,
  readRepoLocation,
  readTranslatedWorktreeGraph,
  readWorktreeHeadOid,
  readWorktreeList,
  toGitOutputSpace
} from './worktree-list-reader'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import {
  WORKTREE_LIST_TIMEOUT_MS,
  getErrorCode,
  isNotGitRepositoryError,
  normalizeLocalBranchRef
} from './worktree-operation-options'
import { areWorktreePathsEqual, translateWorktreePath } from './worktree-path-comparison'
import { detectSparseCheckout, resolveGitCommonDir } from './worktree-sparse-state'
import { resolveGitDir } from './source-control/resolve-git-dir'

const SPARSE_CHECKOUT_DETECTION_CONCURRENCY = 8

export async function listWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    return await readTranslatedWorktreeGraph(repoPath, options)
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
      return []
    }
    console.warn(`[git/worktree] listWorktreeGraph failed for ${repoPath}:`, err)
    return []
  }
}

export async function listWorktreesUnshared(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    const worktrees = await readTranslatedWorktreeGraph(repoPath, options)
    return annotateSparseCheckoutStatus(worktrees)
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
      return []
    }
    // Why: don't swallow git-compat/repo-state failures — else they resurface as opaque "created but not found in listing" errors.
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, err)
    return []
  }
}

export async function listWorktreesStrict(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const worktrees = (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
  return annotateSparseCheckoutStatus(worktrees)
}

async function annotateSparseCheckoutStatus(
  worktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function detectNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (!worktree || worktree.isBare || worktree.isSparse) {
        continue
      }
      const isSparse = await detectSparseCheckout(worktree.path)
      if (isSparse) {
        annotated[index] = { ...worktree, isSparse }
      }
    }
  }

  // Why: cap concurrency so status-poll refreshes don't fan out many sparse-checkout filesystem probes at once.
  const workerCount = Math.min(SPARSE_CHECKOUT_DETECTION_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => detectNext()))
  return annotated
}

/** The repo's common dir from the filesystem; wrong for a bare repo, so only a secondary signal. */
async function readRepoCommonDirFromDisk(repoPath: string): Promise<string | undefined> {
  try {
    return await resolveGitCommonDir(await resolveGitDir(repoPath))
  } catch {
    return undefined
  }
}

async function canonicalizeLocalPath(pathValue: string): Promise<string> {
  try {
    return await realpath(pathValue)
  } catch {
    // A path Git reported from another execution space (WSL, SSH) has no local inode.
    return pathValue
  }
}

/**
 * Whether the created worktree's common dir names the same object store as the repo.
 *
 * Why accept any candidate: the readings come from different spaces — Git resolves symlinks and,
 * under WSL, answers in Linux paths, while the filesystem walk keeps the caller's (possibly UNC)
 * spelling. Comparing only one rejected every symlinked-root, WSL, and bare-repo create (#16520).
 */
async function isSameRepoCommonDir(
  createdCommonDir: string,
  candidates: readonly (string | undefined)[]
): Promise<boolean> {
  const present = candidates.filter((candidate): candidate is string => Boolean(candidate))
  if (present.some((candidate) => areWorktreePathsEqual(createdCommonDir, candidate))) {
    return true
  }
  const [canonicalCreated, ...canonicalCandidates] = await Promise.all(
    [createdCommonDir, ...present].map(canonicalizeLocalPath)
  )
  return canonicalCandidates.some((candidate) => areWorktreePathsEqual(canonicalCreated, candidate))
}

/**
 * Reconstruct the listing row for a worktree `git worktree add` just created, by asking Git about
 * the worktree itself. Used when the listing fails or omits it, so a create does not abandon a
 * worktree Git already wrote to disk (#16520). Returns undefined unless Git resolves the path into
 * this repo's object store with the expected branch checked out.
 */
export async function describeCreatedWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo | undefined> {
  const expectedRef = `refs/heads/${normalizeLocalBranchRef(branch)}`
  // Bound Git recovery after the bounded listing failed; filesystem canonicalization stays best effort.
  const deadlined: GitWorktreeExecOptions = {
    ...options,
    timeout: options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  }
  const [created, repoGitCommonDir, repoDiskCommonDir, checkedOutRef] = await Promise.all([
    readRepoLocation(worktreePath, toGitOutputSpace(worktreePath), deadlined),
    readRepoCommonDirFromGit(repoPath, deadlined),
    readRepoCommonDirFromDisk(repoPath),
    readCheckedOutBranchRef(worktreePath, deadlined)
  ])
  if (!created || checkedOutRef !== expectedRef) {
    return undefined
  }
  if (!(await isSameRepoCommonDir(created.commonDir, [repoGitCommonDir, repoDiskCommonDir]))) {
    return undefined
  }
  const [described] = await annotateSparseCheckoutStatus([
    {
      path: translateWorktreePath(created.topLevel, repoPath, options),
      head: await readWorktreeHeadOid(worktreePath, deadlined),
      branch: expectedRef,
      isBare: false,
      // `git worktree add` only ever produces a linked worktree.
      isMainWorktree: false
    }
  ])
  return described
}
