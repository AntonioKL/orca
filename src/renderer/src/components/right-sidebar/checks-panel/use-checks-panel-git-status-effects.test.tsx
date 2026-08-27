// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeGitStatus: vi.fn(),
  getRuntimeGitUpstreamStatus: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => mocks)

import { useChecksPanelGitStatusEffects } from './use-checks-panel-git-status-effects'
import { deferred, flush, mountProbe, unmountProbes } from '../source-control-hook-test-harness'

const retryTimerRef = { current: null as ReturnType<typeof setTimeout> | null }
const panelContextKeyRef = { current: 'context-A' }
const setGitStatusSnapshot = vi.fn()
const setGitStatusProbeErrorContextKey = vi.fn()
const setGitStatusRefreshNonce = vi.fn()
const updateWorktreeGitIdentity = vi.fn()

function Probe({ nonce }: { nonce: number }): null {
  useChecksPanelGitStatusEffects({
    activeConnectionId: null,
    activeWorktreeId: 'worktree-A',
    activeWorktreePath: '/repo',
    activeWorktreePushTarget: null,
    branch: 'feature',
    eligibilityHeadOidRef: { current: null },
    eligibilityRefreshNonce: 0,
    getHostedReviewCreationEligibility: vi.fn(),
    gitStatusInvalidation: 0,
    gitStatusReadyForPanelContext: false,
    gitStatusRefreshNonce: nonce,
    gitStatusSnapshotRetryTimerRef: retryTimerRef,
    hasUncommittedChanges: false,
    hostedReviewCreationRequestKey: 'eligibility-A',
    isFolder: false,
    isPanelVisible: true,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: null,
    linkedPR: null,
    fallbackGitHubPRNumber: null,
    localExecutionScope: 'host',
    ownerSettings: null,
    panelContextKey: 'context-A',
    panelContextKeyRef,
    remoteStatus: undefined,
    remoteStatusInvalidation: 0,
    repo: { id: 'repo-A', path: '/repo', worktreeBaseRef: 'main' },
    repoConnectionId: null,
    runtimeEnvironmentId: null,
    setGitStatusProbeErrorContextKey,
    setGitStatusRefreshNonce,
    setGitStatusSnapshot,
    setHostedReviewCreationSnapshot: vi.fn(),
    sshConnectionStatus: undefined,
    updateWorktreeGitIdentity
  } as never)
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  retryTimerRef.current = null
  panelContextKeyRef.current = 'context-A'
  mocks.getRuntimeGitStatus.mockReset()
  mocks.getRuntimeGitUpstreamStatus.mockReset()
  setGitStatusSnapshot.mockReset()
  setGitStatusProbeErrorContextKey.mockReset()
  setGitStatusRefreshNonce.mockReset()
  updateWorktreeGitIdentity.mockReset()
})

afterEach(() => {
  unmountProbes()
  vi.useRealTimers()
})

describe('useChecksPanelGitStatusEffects poll runner', () => {
  it('coalesces M nonce ticks into one trailing run after the slowTaskBackoff gap', async () => {
    const first = deferred<{
      entries: never[]
      head: string
      branch: string
      upstreamStatus: { hasUpstream: boolean; ahead: number; behind: number }
    }>()
    const status = {
      entries: [],
      head: 'head-A',
      branch: 'feature',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    }
    mocks.getRuntimeGitStatus.mockReturnValueOnce(first.promise).mockResolvedValue(status)
    const root: Root = await mountProbe(<Probe nonce={0} />)
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    for (let tick = 1; tick <= 5; tick += 1) {
      await act(async () => {
        root.render(<Probe nonce={tick} />)
      })
    }
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      first.resolve(status)
    })
    await flush()
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(49_999)
    })
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(2)
  })
})
