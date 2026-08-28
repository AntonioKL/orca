import { useCallback, useRef } from 'react'
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
  const linkedGitLabMRRef = useRef(linkedGitLabMR)
  const reviewLinkScopeKeyRef = useRef(reviewLinkScopeKey)
  const reviewLinkActionGenerationRef = useRef(0)
  linkedGitLabMRRef.current = linkedGitLabMR
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
    reviewLinkActionGenerationRef.current += 1
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
      suppressHostedReviewRefresh: true,
      afterSave: async ({
        updates
      }: {
        updates?: { linkedPR?: unknown; linkedGitLabMR?: unknown }
      }) => {
        const actionGeneration = reviewLinkActionGenerationRef.current + 1
        reviewLinkActionGenerationRef.current = actionGeneration
        const isActionCurrent = (): boolean =>
          reviewLinkScopeKeyRef.current === openedScopeKey &&
          reviewLinkActionGenerationRef.current === actionGeneration
        if (!isActionCurrent()) {
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
        const isRequestCurrent = (): boolean =>
          isActionCurrent() && linkedGitLabMRRef.current === nextMR
        const refreshedReview = await fetchHostedReviewForBranch(repo.path, branch, {
          repoId: repo.id,
          repoOwnerExecutionHostId: activeWorktree.hostId,
          linkedGitHubPR: null,
          linkedGitLabMR: nextMR,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null
        })
        if (
          !isRequestCurrent() ||
          refreshedReview?.provider !== 'gitlab' ||
          refreshedReview.number !== nextMR
        ) {
          return
        }
        await fetchGitLabDetails({
          mrNumberOverride: nextMR,
          headShaOverride: refreshedReview.headSha ?? null,
          commitAsCurrent: true,
          settingsOverride: capturedOwnerSettings,
          isRequestCurrent
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
    openModal,
    ownerSettings,
    refreshLinkedGitHubPullRequest,
    repo,
    reviewLinkScopeKey
  ])

  return { handleUnlinkReview, handleLinkAnotherReview }
}
