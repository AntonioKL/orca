import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Worktree } from '../../../../shared/worktree/types'

const STANDALONE_ACTIVITY_WORKTREE_REPO_ID = '__activity_standalone__'
const STANDALONE_ACTIVITY_WORKTREES_CAP = 200
const standaloneActivityWorktrees = new Map<string, Worktree>()

function buildStandaloneActivityWorktree(worktreeId: string): Worktree {
  const displayName =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? 'Floating terminal' : 'Standalone terminal'
  return {
    id: worktreeId,
    repoId: STANDALONE_ACTIVITY_WORKTREE_REPO_ID,
    path: '',
    head: '',
    branch: displayName,
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

/** Return a stable synthetic worktree for terminal-only activity. */
export function standaloneActivityWorktree(worktreeId: string): Worktree {
  let worktree = standaloneActivityWorktrees.get(worktreeId)
  if (!worktree) {
    if (standaloneActivityWorktrees.size >= STANDALONE_ACTIVITY_WORKTREES_CAP) {
      standaloneActivityWorktrees.clear()
    }
    worktree = buildStandaloneActivityWorktree(worktreeId)
    standaloneActivityWorktrees.set(worktreeId, worktree)
  }
  return worktree
}
