import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'

const mocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  toastError: vi.fn(),
  setActiveTabType: vi.fn(),
  closeTab: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      tabsByWorktree: {},
      closeTab: mocks.closeTab,
      setActiveTabType: mocks.setActiveTabType
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

const launch = {
  agent: 'claude' as const,
  worktreeId: 'wt-1',
  environmentId: 'env-1',
  groupId: 'group-1',
  startupPlan: { launchCommand: 'claude' } as AgentStartupPlan,
  prompt: '',
  promptDelivery: 'auto-submit' as const,
  pastePromptAfterReady: null,
  submitPastedPrompt: false
}

describe('launchAgentInWebHostTab unconfirmed launches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not report an unverifiable launch as a definite failure', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'unverifiable',
      message: 'relay connection reset'
    })
    const { launchAgentInWebHostTab } = await import('./launch-agent-web-host-tab')

    const result = await launchAgentInWebHostTab(launch)

    expect(result).toEqual({ delivered: false, failureNotified: true })
    const message = mocks.toastError.mock.calls[0]?.[0] as string
    expect(message).toMatch(/could not confirm/i)
    expect(message).toMatch(/relay connection reset/)
    expect(message).toMatch(/before trying again/i)
    expect(message).not.toMatch(/^Could not launch/i)
  })

  it('still reports a delivered refusal as a definite failure', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'worktree is required'
    })
    const { launchAgentInWebHostTab } = await import('./launch-agent-web-host-tab')

    await launchAgentInWebHostTab(launch)

    expect(mocks.toastError).toHaveBeenCalledWith('worktree is required')
  })
})
