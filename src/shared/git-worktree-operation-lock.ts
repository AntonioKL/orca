import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { runWithGitOperationLock } from './git-operation-lock'

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  // Why: the key must resolve synchronously so back-to-back callers (stage, then commit)
  // join the lane in call order. An async realpath is not ordered and can run a commit first.
  let key = resolve(worktreePath)
  try {
    key = realpathSync.native(worktreePath) || key
  } catch {
    // A missing or temporarily unreachable worktree still gets serialized.
  }
  return runWithGitOperationLock(key, signal, run)
}
