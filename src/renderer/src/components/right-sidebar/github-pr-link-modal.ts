import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'

type GitHubPRLinkModalWorktree = Pick<
  Worktree,
  'repoId' | 'hostId' | 'displayName' | 'linkedIssue' | 'comment'
>

export function openGitHubPRLinkModal({
  openModal,
  worktree,
  worktreeId,
  currentPR,
  afterLinked
}: {
  openModal: AppState['openModal']
  worktree: GitHubPRLinkModalWorktree
  worktreeId: string
  currentPR: number
  afterLinked?: (linkedPR: number) => void
}): void {
  openModal('edit-meta', {
    worktreeId,
    // Why: the same workspace ID can exist under two hosts. Naming the owner
    // keeps the dialog on this workspace instead of the ambiguous lookup.
    repoId: worktree.repoId,
    executionHostId: worktree.hostId,
    currentDisplayName: worktree.displayName,
    currentIssue: worktree.linkedIssue,
    currentPR,
    currentComment: worktree.comment,
    focus: 'pr',
    ...(afterLinked
      ? {
          afterSave: ({ updates }: { updates?: { linkedPR?: unknown } }) => {
            if (typeof updates?.linkedPR === 'number') {
              afterLinked(updates.linkedPR)
            }
          }
        }
      : {})
  })
}
