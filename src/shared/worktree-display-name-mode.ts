import type { Worktree, WorktreeMeta } from './types'

/**
 * Resolve whether branch renames may replace a workspace title. Reads the pinned
 * flag recorded when the name was written; rows predating that flag fall back to
 * "a stored name means the user picked it", which is what they were created under.
 */
export function resolveWorktreeDisplayNameMode(
  meta: Partial<Pick<WorktreeMeta, 'displayName' | 'displayNameIsPinned'>> | undefined
): NonNullable<Worktree['displayNameMode']> {
  if (meta?.displayNameIsPinned !== undefined) {
    return meta.displayNameIsPinned ? 'fixed' : 'automatic'
  }
  return meta?.displayName?.trim() ? 'fixed' : 'automatic'
}
