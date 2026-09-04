import type { AppState } from '../../store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '../../store/selectors'
import type { CheckStatus } from '../../../../shared/github/pull-request-types'
import { getGitHubPRCacheKey } from '../../store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '../../store/slices/hosted-review-cache-identity'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'

type ActiveChecksStatusState = Pick<
  AppState,
  'activeWorktreeId' | 'worktreesByRepo' | 'repos' | 'prCache'
> &
  Partial<Pick<AppState, 'settings' | 'hostedReviewCache'>>

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

// Why cached: the right sidebar is always mounted, so this ran on every store write and rebuilt two
// cache-key strings each time. Same single-entry, reference-keyed shape as selectFloatingVisibleTabCount.
let activeChecksStatusCache: {
  activeWorktreeId: ActiveChecksStatusState['activeWorktreeId']
  worktreesByRepo: ActiveChecksStatusState['worktreesByRepo']
  repos: ActiveChecksStatusState['repos']
  prCache: ActiveChecksStatusState['prCache']
  settings: ActiveChecksStatusState['settings']
  hostedReviewCache: ActiveChecksStatusState['hostedReviewCache']
  status: CheckStatus | null
} | null = null

/** @internal */
export function clearActiveChecksStatusCacheForTests(): void {
  activeChecksStatusCache = null
}

export function getActiveChecksStatus(state: ActiveChecksStatusState): CheckStatus | null {
  const cached = activeChecksStatusCache
  if (
    cached &&
    cached.activeWorktreeId === state.activeWorktreeId &&
    cached.worktreesByRepo === state.worktreesByRepo &&
    cached.repos === state.repos &&
    cached.prCache === state.prCache &&
    cached.settings === state.settings &&
    cached.hostedReviewCache === state.hostedReviewCache
  ) {
    return cached.status
  }
  const status = computeActiveChecksStatus(state)
  activeChecksStatusCache = {
    activeWorktreeId: state.activeWorktreeId,
    worktreesByRepo: state.worktreesByRepo,
    repos: state.repos,
    prCache: state.prCache,
    settings: state.settings,
    hostedReviewCache: state.hostedReviewCache,
    status
  }
  return status
}

function computeActiveChecksStatus(state: ActiveChecksStatusState): CheckStatus | null {
  const activeWorktree = state.activeWorktreeId
    ? (getWorktreeMapFromState(state).get(state.activeWorktreeId) ?? null)
    : null
  if (!activeWorktree) {
    return null
  }

  const activeRepo = getRepoMapFromState(state).get(activeWorktree.repoId)
  if (!activeRepo) {
    return null
  }

  const branch = branchDisplayName(activeWorktree.branch)
  if (!branch) {
    return null
  }

  // Why: PR refreshes are written under repo-id scoped keys so repo path
  // changes and legacy duplicates cannot leave the activity indicator stale.
  const prCacheKey = getGitHubPRCacheKey(
    activeRepo.path,
    activeRepo.id,
    branch,
    state.settings,
    activeRepo.connectionId,
    activeRepo.executionHostId,
    true
  )
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    activeRepo.path,
    branch,
    state.settings,
    activeRepo.id,
    activeRepo.connectionId,
    activeRepo.executionHostId,
    true
  )
  const hostedReview = state.hostedReviewCache?.[hostedReviewCacheKey]?.data ?? null
  if (hostedReview && hostedReview.provider !== 'github') {
    return hostedReview.status
  }
  if (
    (activeWorktree.linkedGitLabMR ?? null) !== null ||
    (activeWorktree.linkedBitbucketPR ?? null) !== null ||
    (activeWorktree.linkedAzureDevOpsPR ?? null) !== null ||
    (activeWorktree.linkedGiteaPR ?? null) !== null
  ) {
    return null
  }
  const branchPR = state.prCache[prCacheKey]?.data ?? null
  if (branchPR && !isGitHubPRSuppressed(activeWorktree, branchPR.number)) {
    return branchPR.checksStatus
  }
  return hostedReview?.provider === 'github' &&
    !isGitHubPRSuppressed(activeWorktree, hostedReview.number)
    ? hostedReview.status
    : null
}
