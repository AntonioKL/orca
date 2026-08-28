// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChecksPanelCheckAndReviewActions } from './use-checks-panel-check-and-review-actions'

type Input = Parameters<typeof useChecksPanelCheckAndReviewActions>[0]

afterEach(cleanup)

function makeInput(overrides: Partial<Input> = {}): Input {
  const worktree = {
    id: 'repo-1::/workspace/repo',
    repoId: 'repo-1',
    path: '/workspace/repo',
    branch: 'refs/heads/feature/mr',
    hostId: 'ssh:ssh-1',
    displayName: 'MR workspace',
    linkedGitLabMR: 42,
    linkedPR: null,
    comment: ''
  }
  return {
    activeReview: {
      provider: 'gitlab',
      number: 42,
      title: 'GitLab review',
      state: 'open',
      url: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
      status: 'success',
      updatedAt: null,
      mergeable: 'UNKNOWN'
    },
    activeWorktree: worktree as Input['activeWorktree'],
    activeWorktreeId: worktree.id,
    asyncResultKeyRef: { current: '' },
    branch: 'feature/mr',
    checks: [],
    fetchGitLabDetails: vi.fn(),
    fetchHostedReviewForBranch: vi.fn(),
    fetchPRCheckDetails: vi.fn(),
    fetchPRChecks: vi.fn(),
    fetchPRComments: vi.fn(),
    fetchPRForBranch: vi.fn(),
    gitLabProjectRefRef: { current: null },
    isCurrentAsyncResult: vi.fn(() => true),
    isFixingChecksWithAI: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: 42,
    linkedPR: null,
    localExecutionScope: null,
    openModal: vi.fn(),
    ownerSettings: { activeRuntimeEnvironmentId: null } as Input['ownerSettings'],
    panelContextKey: 'context',
    panelContextKeyRef: { current: 'context' },
    pr: null,
    prCacheKey: 'pr-cache',
    repo: {
      id: 'repo-1',
      path: '/workspace/repo',
      connectionId: 'ssh-1'
    } as NonNullable<Input['repo']>,
    repoConnectionId: 'ssh-1',
    runtimeEnvironmentId: null,
    settings: null,
    setChecks: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsLoading: vi.fn(),
    setIsFixingChecksWithAI: vi.fn(),
    sourceControlAiActionsVisible: false,
    stateRequestKey: 'state',
    updateWorktreeMeta: vi.fn(),
    ...overrides
  } as Input
}

describe('useChecksPanelCheckAndReviewActions GitLab links', () => {
  it('unlinks the displayed MR through its provider slot', () => {
    const input = makeInput()
    const { result } = renderHook(() => useChecksPanelCheckAndReviewActions(input))

    act(() => result.current.handleUnlinkReview())

    expect(input.updateWorktreeMeta).toHaveBeenCalledWith(
      input.activeWorktreeId,
      { linkedGitLabMR: null },
      { executionHostId: 'ssh:ssh-1' }
    )
  })

  it('refreshes a replacement MR on the captured owner and exact returned review', async () => {
    const fetchGitLabDetails = vi.fn()
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue({
      provider: 'gitlab',
      number: 43,
      title: 'Replacement',
      state: 'open',
      url: 'https://gitlab.example.com/group/repo/-/merge_requests/43',
      status: 'success',
      updatedAt: null,
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })
    const openModal = vi.fn()
    const input = makeInput({ fetchGitLabDetails, fetchHostedReviewForBranch, openModal })
    const hook = renderHook(({ model }) => useChecksPanelCheckAndReviewActions(model), {
      initialProps: { model: input }
    })

    act(() => hook.result.current.handleLinkAnotherReview())
    const modal = openModal.mock.calls[0]?.[1]
    expect(modal.suppressHostedReviewRefresh).toBe(true)
    hook.rerender({
      model: {
        ...input,
        activeWorktree: { ...input.activeWorktree, linkedGitLabMR: 43 },
        linkedGitLabMR: 43,
        panelContextKey: 'context::gitlab::43'
      } as Input
    })
    await act(async () => modal.afterSave({ updates: { linkedGitLabMR: 43 } }))

    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/mr',
      expect.objectContaining({
        linkedGitLabMR: 43,
        repoOwnerExecutionHostId: 'ssh:ssh-1'
      })
    )
    expect(fetchHostedReviewForBranch).toHaveBeenCalledOnce()
    expect(fetchGitLabDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        mrNumberOverride: 43,
        headShaOverride: 'abc123',
        commitAsCurrent: true,
        settingsOverride: input.ownerSettings,
        isRequestCurrent: expect.any(Function)
      })
    )
  })

  it('drops an older replacement MR refresh when a newer relink wins', async () => {
    const reviewResolvers = new Map<number, (value: NonNullable<Input['activeReview']>) => void>()
    const fetchHostedReviewForBranch = vi.fn(
      (_repoPath: string, _branch: string, options?: { linkedGitLabMR?: number | null }) =>
        new Promise<NonNullable<Input['activeReview']>>((resolve) => {
          reviewResolvers.set(options?.linkedGitLabMR ?? 0, resolve)
        })
    )
    const fetchGitLabDetails = vi.fn()
    const openModal = vi.fn()
    const input = makeInput({ fetchGitLabDetails, fetchHostedReviewForBranch, openModal })
    const hook = renderHook(({ model }) => useChecksPanelCheckAndReviewActions(model), {
      initialProps: { model: input }
    })

    act(() => hook.result.current.handleLinkAnotherReview())
    const firstModal = openModal.mock.calls[0]?.[1]
    hook.rerender({
      model: {
        ...input,
        activeWorktree: { ...input.activeWorktree, linkedGitLabMR: 43 },
        linkedGitLabMR: 43,
        panelContextKey: 'context::gitlab::43'
      } as Input
    })
    const firstSave = firstModal.afterSave({ updates: { linkedGitLabMR: 43 } })
    await act(() => Promise.resolve())

    act(() => hook.result.current.handleLinkAnotherReview())
    const secondModal = openModal.mock.calls[1]?.[1]
    hook.rerender({
      model: {
        ...input,
        activeWorktree: { ...input.activeWorktree, linkedGitLabMR: 44 },
        linkedGitLabMR: 44,
        panelContextKey: 'context::gitlab::44'
      } as Input
    })
    const secondSave = secondModal.afterSave({ updates: { linkedGitLabMR: 44 } })
    await act(() => Promise.resolve())

    reviewResolvers.get(43)?.({
      ...(input.activeReview as NonNullable<Input['activeReview']>),
      number: 43,
      headSha: 'head-43'
    })
    reviewResolvers.get(44)?.({
      ...(input.activeReview as NonNullable<Input['activeReview']>),
      number: 44,
      headSha: 'head-44'
    })
    await act(async () => firstSave)
    await act(async () => secondSave)

    expect(fetchGitLabDetails).toHaveBeenCalledOnce()
    expect(fetchGitLabDetails).toHaveBeenCalledWith(
      expect.objectContaining({ mrNumberOverride: 44, headShaOverride: 'head-44' })
    )
  })

  it('drops replacement MR results after an external link mutation', async () => {
    let resolveReview!: (value: NonNullable<Input['activeReview']>) => void
    const fetchHostedReviewForBranch = vi.fn(
      () =>
        new Promise<NonNullable<Input['activeReview']>>((resolve) => {
          resolveReview = resolve
        })
    )
    const fetchGitLabDetails = vi.fn()
    const openModal = vi.fn()
    const input = makeInput({ fetchGitLabDetails, fetchHostedReviewForBranch, openModal })
    const hook = renderHook(({ model }) => useChecksPanelCheckAndReviewActions(model), {
      initialProps: { model: input }
    })

    act(() => hook.result.current.handleLinkAnotherReview())
    const modal = openModal.mock.calls[0]?.[1]
    hook.rerender({
      model: {
        ...input,
        activeWorktree: { ...input.activeWorktree, linkedGitLabMR: 43 },
        linkedGitLabMR: 43,
        panelContextKey: 'context::gitlab::43'
      } as Input
    })
    const save = modal.afterSave({ updates: { linkedGitLabMR: 43 } })
    await act(() => Promise.resolve())

    hook.rerender({
      model: {
        ...input,
        activeWorktree: { ...input.activeWorktree, linkedGitLabMR: 44 },
        linkedGitLabMR: 44,
        panelContextKey: 'context::gitlab::44'
      } as Input
    })
    resolveReview({
      ...(input.activeReview as NonNullable<Input['activeReview']>),
      number: 43,
      headSha: 'head-43'
    })
    await act(async () => save)

    expect(fetchGitLabDetails).not.toHaveBeenCalled()
  })
})
