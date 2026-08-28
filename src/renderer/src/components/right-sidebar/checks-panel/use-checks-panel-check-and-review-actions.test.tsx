// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'
import { useChecksPanelCheckAndReviewActions } from './use-checks-panel-check-and-review-actions'

function renderActions(overrides: Partial<ChecksPanelCheckAndReviewActionsInput> = {}) {
  const updateWorktreeMeta = vi.fn()
  const openModal = vi.fn()
  const model = {
    activeReview: {
      provider: 'github',
      number: 42,
      title: 'Detected PR',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/42',
      status: 'pending',
      updatedAt: '2026-08-27T00:00:00Z',
      mergeable: 'UNKNOWN'
    },
    activeWorktree: {
      id: 'wt-1',
      repoId: 'repo-1',
      hostId: 'ssh:devbox',
      displayName: 'feature',
      linkedIssue: null,
      linkedPR: null,
      comment: ''
    },
    activeWorktreeId: 'wt-1',
    linkedPR: null,
    suppressedGitHubPR: null,
    updateWorktreeMeta,
    openModal,
    ...overrides
  } as unknown as ChecksPanelCheckAndReviewActionsInput

  return {
    ...renderHook(() => useChecksPanelCheckAndReviewActions(model)),
    openModal,
    updateWorktreeMeta
  }
}

describe('useChecksPanelCheckAndReviewActions', () => {
  it('unlinks an auto-detected PR with a durable suppression tombstone', () => {
    const { result, updateWorktreeMeta } = renderActions()

    act(() => result.current.handleUnlinkPullRequest())

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'wt-1',
      { linkedPR: null, suppressedGitHubPR: 42 },
      { executionHostId: 'ssh:devbox' }
    )
  })

  it('can relink from durable suppression before PR data refetches', () => {
    const { result, openModal } = renderActions({
      activeReview: null,
      suppressedGitHubPR: 42
    })

    act(() => result.current.handleLinkSuppressedPullRequest())

    expect(openModal).toHaveBeenCalledWith(
      'edit-meta',
      expect.objectContaining({ worktreeId: 'wt-1', currentPR: 42, focus: 'pr' })
    )
  })
})
