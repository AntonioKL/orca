import type { Worktree } from './types'

type GitHubPRSuppressionMetadata = Pick<Worktree, 'linkedPR' | 'suppressedGitHubPR'>

export function isGitHubPRSuppressed(
  { linkedPR, suppressedGitHubPR }: GitHubPRSuppressionMetadata,
  prNumber: number
): boolean {
  return linkedPR === null && suppressedGitHubPR === prNumber
}
