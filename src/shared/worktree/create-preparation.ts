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
  if (worktree.lockReason?.startsWith(WORKTREE_CREATE_PREPARATION_LOCK_PREFIX)) {
    return true
  }
  // A real branch worktree under a user-chosen `.orca-preparing` directory
  // must stay visible and must never be eligible for destructive stale cleanup.
  if (worktree.branch) {
    return false
  }
  const pathParts = worktree.path.split(/[\\/]+/)
  return pathParts.includes(WORKTREE_CREATE_PREPARATION_DIRECTORY)
}
