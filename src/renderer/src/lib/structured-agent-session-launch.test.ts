import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { launchStructuredCodexSession } from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { startStructuredCodexLaunch } from './structured-agent-session-launch'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-structured-codex-session', () => ({
  launchStructuredCodexSession: vi.fn()
}))

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

describe('startStructuredCodexLaunch', () => {
  beforeEach(() => {
    vi.mocked(toast.message).mockReset()
    vi.mocked(toast.error).mockReset()
    vi.mocked(launchStructuredCodexSession).mockReset()
    vi.mocked(refreshLocalStructuredSessionTabs).mockReset()
  })

  it('opens the chat without an informational progress toast', async () => {
    const worktreeId = 'wt-open-quiet'
    vi.mocked(launchStructuredCodexSession).mockResolvedValue('session-1')
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, 'session-1')
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(launchStructuredCodexSession).toHaveBeenCalledTimes(1)
    expect(launchStructuredCodexSession).toHaveBeenCalledWith(worktreeId)
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('coalesces a duplicate click silently while the launch is in flight', async () => {
    const worktreeId = 'wt-duplicate-click'
    let resolveLaunch: (sessionId: string) => void = () => {}
    vi.mocked(launchStructuredCodexSession).mockImplementation(
      () => new Promise<string>((resolve) => (resolveLaunch = resolve))
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, 'session-2')
    ])

    startStructuredCodexLaunch(worktreeId)
    startStructuredCodexLaunch(worktreeId)

    expect(launchStructuredCodexSession).toHaveBeenCalledTimes(1)
    expect(toast.message).not.toHaveBeenCalled()

    resolveLaunch('session-2')
    await flushLaunchSettlement()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps the actionable error toast when the launch fails', async () => {
    const worktreeId = 'wt-launch-fails'
    vi.mocked(launchStructuredCodexSession).mockRejectedValue(new Error('codex binary missing'))

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Could not open Codex chat', {
      description: 'codex binary missing'
    })
    expect(toast.message).not.toHaveBeenCalled()
  })

  it('releases the single-flight reservation after a failed launch so a retry relaunches', async () => {
    const worktreeId = 'wt-retry-after-failure'
    vi.mocked(launchStructuredCodexSession).mockRejectedValueOnce(new Error('transient'))
    vi.mocked(launchStructuredCodexSession).mockResolvedValueOnce('session-3')
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, 'session-3')
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    expect(toast.error).toHaveBeenCalledTimes(1)

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(launchStructuredCodexSession).toHaveBeenCalledTimes(2)
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
