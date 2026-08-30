export const WORKTREE_CREATE_PREPARATION_DIRECTORY = '.orca-preparing'
export const WORKTREE_CREATE_PREPARATION_LOCK_PREFIX = 'orca-create-preparation:v1:'

export function createWorktreePreparationLockReason(sessionId: string): string {
  return `${WORKTREE_CREATE_PREPARATION_LOCK_PREFIX}${process.pid}:${sessionId}`
}

export function parseWorktreePreparationOwnerPid(lockReason?: string): number | null {
  if (!lockReason?.startsWith(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX)) {
    return null
  }
  const pid = Number(lockReason.slice(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX.length).split(':')[0])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function parseWorktreePreparationPathOwnerPid(path: string): number | null {
  const pathParts = path.split(/[\\/]+/)
  const preparationIndex = pathParts.lastIndexOf(WORKTREE_CREATE_PREPARATION_DIRECTORY)
  if (preparationIndex === -1) {
    return null
  }
  const pid = Number(pathParts[preparationIndex + 1]?.split('-')[0])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function isWorktreeCreatePreparation(worktree: {
  path: string
  lockReason?: string
  branch?: string
}): boolean {
  // The Git lock reason is the durable ownership proof. A path can be chosen
  // by a user (including for an uncommitted detached worktree), so path shape
  // alone must never hide or force-remove it. A crash before locking may leave
  // an unlocked detached entry for manual cleanup, but cannot delete user data.
  return worktree.lockReason?.startsWith(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX) ?? false
}
