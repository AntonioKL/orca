import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeStructuredAgentSession: vi.fn(),
  closeTab: vi.fn(),
  getState: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null),
  toHostSessionTabId: vi.fn((tabId: string) => tabId),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, message: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  toHostSessionTabId: mocks.toHostSessionTabId
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

import { closeTerminalTab } from './terminal-tab-actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.closeStructuredAgentSession.mockResolvedValue('closed')
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
})

describe('structured session disposal from terminal close', () => {
  it('disposes the native owner when an adopted TUI tab closes from chat view', async () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'terminal-1',
            contentType: 'terminal',
            structuredSessionId: 'codex-adopted-1',
            viewMode: 'chat'
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: mocks.closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('terminal-1')

    await vi.waitFor(() =>
      expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith(
        { kind: 'local' },
        'codex-adopted-1'
      )
    )
  })

  it('keeps natural adopted-TUI exits on the ownership reconciliation path', () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'terminal-1',
            contentType: 'terminal',
            structuredSessionId: 'codex-adopted-1',
            viewMode: 'chat'
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: mocks.closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('terminal-1', { reason: 'pty-exit' })

    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('names the tab\u2019s own provider when every structured-owner close attempt fails', async () => {
    vi.useFakeTimers()
    try {
      mocks.closeStructuredAgentSession.mockRejectedValue(new Error('host unavailable'))
      mocks.getState.mockReturnValue({
        settings: { activeRuntimeEnvironmentId: null },
        tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              entityId: 'terminal-1',
              contentType: 'terminal',
              structuredSessionId: 'claude-adopted-1',
              agentSessionAgent: 'claude',
              viewMode: 'chat'
            }
          ]
        },
        activeWorktreeId: 'wt-1',
        activeTabId: 'terminal-2',
        openFiles: [],
        browserTabsByWorktree: {},
        closeTab: mocks.closeTab,
        setActiveTab: vi.fn()
      })

      closeTerminalTab('terminal-1')
      // Why: the disposal helper walks its whole retry ladder before it reports failure.
      await vi.advanceTimersByTimeAsync(4_250)

      expect(mocks.toastError.mock.calls[0]?.[0]).toBe('Could not close this Claude chat')
      expect(mocks.closeTab).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient structured-owner close after the tab is removed', async () => {
    vi.useFakeTimers()
    try {
      mocks.closeStructuredAgentSession
        .mockRejectedValueOnce(new Error('host unavailable'))
        .mockResolvedValueOnce('closed')
      mocks.getState.mockReturnValue({
        settings: { activeRuntimeEnvironmentId: null },
        tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              entityId: 'terminal-1',
              contentType: 'terminal',
              structuredSessionId: 'codex-adopted-1',
              viewMode: 'chat'
            }
          ]
        },
        activeWorktreeId: 'wt-1',
        activeTabId: 'terminal-2',
        openFiles: [],
        browserTabsByWorktree: {},
        closeTab: mocks.closeTab,
        setActiveTab: vi.fn()
      })

      closeTerminalTab('terminal-1')
      await vi.advanceTimersByTimeAsync(250)
      expect(mocks.closeStructuredAgentSession).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
