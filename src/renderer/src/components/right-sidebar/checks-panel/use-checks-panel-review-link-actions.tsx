import { useCallback, useRef } from 'react'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'

type RefreshLinkedGitHubPullRequest = (linkedPRNumber: number) => Promise<void>

export function useChecksPanelReviewLinkActions(
  model: ChecksPanelCheckAndReviewActionsInput,
  refreshLinkedGitHubPullRequest: RefreshLinkedGitHubPullRequest
) {
  const {
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    linkedGitLabMR,
    linkedPR,
    localExecutionScope,
    openModal,
    ownerSettings,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    updateWorktreeMeta
  } = model
  const reviewLinkScopeKey = JSON.stringify([
    repo?.id ?? null,
    repo?.path ?? null,
    activeWorktree?.id ?? null,
    activeWorktree?.path ?? null,
    branch,
    activeWorktree?.hostId ?? null,
    repo?.executionHostId ?? null,
    repoConnectionId,
    runtimeEnvironmentId,
    localExecutionScope
  ])
  const reviewLinkScopeKeyRef = useRef(reviewLinkScopeKey)
  reviewLinkScopeKeyRef.current = reviewLinkScopeKey

  const handleUnlinkReview = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || !activeReview) {
      return
    }
    const updates =
      activeReview.provider === 'gitlab'
        ? linkedGitLabMR === null
          ? null
          : { linkedGitLabMR: null }
        : linkedPR === null
          ? null
          : { linkedPR: null }
    if (!updates) {
      return
    }
    void updateWorktreeMeta(activeWorktreeId, updates, { executionHostId: activeWorktree.hostId })
  }, [activeReview, activeWorktree, activeWorktreeId, linkedGitLabMR, linkedPR, updateWorktreeMeta])

  const handleLinkAnotherReview = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || !activeReview || !repo || !branch) {
      return
    }
    const provider = activeReview.provider
    const openedScopeKey = reviewLinkScopeKey
    const capturedOwnerSettings = ownerSettings
    openModal('edit-meta', {
      worktreeId: activeWorktreeId,
      // Why: the same workspace ID can exist under two hosts, so pin the dialog to its owner.
      repoId: activeWorktree.repoId,
      executionHostId: activeWorktree.hostId,
      currentDisplayName: activeWorktree.displayName,
      currentIssue: activeWorktree.linkedIssue,
      reviewProvider: provider,
      currentReview:
        provider === 'gitlab'
          ? (activeWorktree.linkedGitLabMR ?? activeReview.number)
          : (activeWorktree.linkedPR ?? activeReview.number),
      currentComment: activeWorktree.comment,
      focus: 'pr',
      afterSave: async ({
        updates
      }: {
        updates?: { linkedPR?: unknown; linkedGitLabMR?: unknown }
      }) => {
        if (reviewLinkScopeKeyRef.current !== openedScopeKey) {
          return
        }
        if (provider === 'github') {
          if (typeof updates?.linkedPR === 'number') {
            await refreshLinkedGitHubPullRequest(updates.linkedPR)
          }
          return
        }
        const nextMR = updates?.linkedGitLabMR
        if (typeof nextMR !== 'number') {
          return
        }
        const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          linkedGitHubPR: null,
          linkedGitLabMR: nextMR,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null,
          repoOwnerExecutionHostId: activeWorktree.hostId,
          repoOwnerCacheScope:
            localExecutionScope ?? runtimeEnvironmentId ?? repoConnectionId ?? activeWorktree.hostId
        })
        if (
          reviewLinkScopeKeyRef.current !== openedScopeKey ||
          refreshedReview?.provider !== 'gitlab' ||
          refreshedReview.number !== nextMR
        ) {
          return
        }
        await fetchGitLabDetails({
          mrNumberOverride: nextMR,
          headShaOverride: refreshedReview.headSha ?? null,
          commitAsCurrent: true,
          settingsOverride: capturedOwnerSettings
        })
      }
    })
  }, [
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    localExecutionScope,
    openModal,
    ownerSettings,
    refreshLinkedGitHubPullRequest,
    repo,
    repoConnectionId,
    reviewLinkScopeKey,
    runtimeEnvironmentId
  ])

  return { handleUnlinkReview, handleLinkAnotherReview }
}
