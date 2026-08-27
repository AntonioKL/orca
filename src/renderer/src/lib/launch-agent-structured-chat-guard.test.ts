import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockSetTabViewMode = vi.fn()
const mockWaitForAgentReady = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockMarkNativeChatLaunchPromptFailed = vi.fn()
const mockLaunchStructuredAgentSession = vi.fn()
const mockRefreshLocalStructuredSessionTabs = vi.fn()
const mockToastError = vi.fn()

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    experimentalNativeChat: true,
    experimentalStructuredNativeChat: true,
    openAgentTabsInChatByDefault: true
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map(),
  transientClearedAgentStatusConnectionIds: {},
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', projectId: 'repo-1', path: '/repo/worktree' }]
  },
  detectedWorktreesByRepo: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabViewMode: mockSetTabViewMode,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: mockToastError } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-ready-wait', () => ({ waitForAgentReady: mockWaitForAgentReady }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))
vi.mock('@/lib/launch-structured-agent-session', () => ({
  launchStructuredAgentSession: mockLaunchStructuredAgentSession
}))
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs,
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))

/** Structured adoption creates the tab in terminal mode and flips it to chat once
 *  the provider is ready; the bridge stamps `viewMode: 'chat'` on the tab up front. That
 *  difference is the only observable signal that the availability guard ran. */
describe('structured chat adoption guard on the launch path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.projects = [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' } }]
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    mockLaunchStructuredAgentSession.mockResolvedValue('codex-session-1')
    mockRefreshLocalStructuredSessionTabs.mockResolvedValue([
      {
        worktree: 'wt-1',
        tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }]
      }
    ])
    mockToastError.mockReset()
    store.settings.experimentalNativeChat = true
    store.settings.experimentalStructuredNativeChat = true
    store.settings.openAgentTabsInChatByDefault = true
  })

  it('uses the updated structured-chat toggle without the legacy chat-default setting', async () => {
    store.settings.openAgentTabsInChatByDefault = false
    const { launchAgentInNewTab, shouldQueueTerminalFocusAfterMenuClose } =
      await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      tabId: null,
      pasteDraftAfterLaunch: false,
      focusAfterMenuClose: 'structured-session'
    })
    expect(shouldQueueTerminalFocusAfterMenuClose(result!)).toBe(false)
    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledWith('wt-1', 'codex')
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it('opens an unprompted local Claude launch as a provider-explicit structured session', async () => {
    mockLaunchStructuredAgentSession.mockResolvedValueOnce('claude-session-1')
    mockRefreshLocalStructuredSessionTabs.mockResolvedValueOnce([
      {
        worktree: 'wt-1',
        tabs: [{ type: 'agent-session', sessionId: 'claude-session-1' }]
      }
    ])
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(result).toMatchObject({
      tabId: null,
      pasteDraftAfterLaunch: false,
      focusAfterMenuClose: 'structured-session'
    })
    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledWith('wt-1', 'claude')
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('does not coalesce concurrent Codex and Claude launches in one worktree', async () => {
    const pendingLaunches = new Map<string, (sessionId: string) => void>()
    mockRefreshLocalStructuredSessionTabs.mockResolvedValue([
      {
        worktree: 'wt-1',
        tabs: [
          { type: 'agent-session', sessionId: 'codex-session-1' },
          { type: 'agent-session', sessionId: 'claude-session-1' }
        ]
      }
    ])
    mockLaunchStructuredAgentSession.mockImplementation(
      (_worktreeId: string, agent: string) =>
        new Promise<string>((resolve) => pendingLaunches.set(agent, resolve))
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredAgentSession).toHaveBeenNthCalledWith(1, 'wt-1', 'codex')
    expect(mockLaunchStructuredAgentSession).toHaveBeenNthCalledWith(2, 'wt-1', 'claude')
    pendingLaunches.get('codex')?.('codex-session-1')
    pendingLaunches.get('claude')?.('claude-session-1')
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(2))
  })

  it.each(['claude', 'codex'] as const)(
    'keeps %s terminal-backed when the parent setting is off and child setting is on',
    async (agent) => {
      store.settings.experimentalNativeChat = false
      store.settings.experimentalStructuredNativeChat = true
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      const result = launchAgentInNewTab({ agent, worktreeId: 'wt-1' })

      expect(result?.tabId).toBe('tab-1')
      expect(mockCreateTab).toHaveBeenCalledWith(
        'wt-1',
        undefined,
        undefined,
        expect.objectContaining({ launchAgent: agent })
      )
      expect(mockLaunchStructuredAgentSession).not.toHaveBeenCalled()
    }
  )

  it('surfaces a direct structured launch failure instead of silently doing nothing', async () => {
    mockLaunchStructuredAgentSession.mockRejectedValueOnce(new Error('provider unavailable'))
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).toMatchObject({ tabId: null, pasteDraftAfterLaunch: false })
    await vi.waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Could not open Codex chat',
        expect.objectContaining({
          description: 'provider unavailable',
          action: expect.objectContaining({ label: 'Open terminal agent' })
        })
      )
    )
    expect(mockCreateTab).not.toHaveBeenCalled()

    const action = mockToastError.mock.calls[0]?.[1]?.action as { onClick: () => void } | undefined
    action?.onClick()
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
  })

  it('names Claude in its structured launch failure', async () => {
    mockLaunchStructuredAgentSession.mockRejectedValueOnce(new Error('provider unavailable'))
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1' })

    await vi.waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Could not open Claude chat',
        expect.objectContaining({
          description: 'provider unavailable',
          action: expect.objectContaining({ label: 'Open terminal agent' })
        })
      )
    )
  })

  it('coalesces repeated structured launches for one worktree while the host is starting', async () => {
    let resolveLaunch!: (sessionId: string) => void
    mockLaunchStructuredAgentSession.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveLaunch = resolve))
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const first = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    const second = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(first).toMatchObject({ focusAfterMenuClose: 'structured-session' })
    expect(second).toMatchObject({ focusAfterMenuClose: 'structured-session' })
    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledTimes(1)
    resolveLaunch('codex-session-1')
  })

  it('keeps the single-flight reservation until the published tab inventory is refreshed', async () => {
    let resolveRefresh!: (snapshots: unknown[]) => void
    mockRefreshLocalStructuredSessionTabs.mockImplementationOnce(
      () => new Promise<unknown[]>((resolve) => (resolveRefresh = resolve))
    )
    mockLaunchStructuredAgentSession.mockResolvedValue('codex-session-1')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(1))

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledTimes(1)
    resolveRefresh([
      { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }] }
    ])
    await vi.waitFor(() => expect(mockToastError).not.toHaveBeenCalled())
  })

  it('does not create a sibling when post-create visibility proof is unknown', async () => {
    mockLaunchStructuredAgentSession.mockResolvedValue('codex-session-1')
    mockRefreshLocalStructuredSessionTabs
      .mockRejectedValueOnce(new Error('inventory unavailable'))
      .mockResolvedValueOnce([
        { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }] }
      ])
      .mockResolvedValueOnce([
        { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: 'codex-session-2' }] }
      ])
    mockLaunchStructuredAgentSession
      .mockResolvedValueOnce('codex-session-1')
      .mockResolvedValueOnce('codex-session-2')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(2))

    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A successful retry must release the reservation so a later launch can start normally.
    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(3))
    expect(mockLaunchStructuredAgentSession).toHaveBeenCalledTimes(2)
  })

  it('keeps prompted Codex on the ordinary terminal launch path', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task'
    })

    expect(result?.tabId).toBe('tab-1')
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
    expect(mockSetTabViewMode).not.toHaveBeenCalled()
  })

  it('keeps prompted Claude on the ordinary terminal launch path', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'start this task'
    })

    expect(result?.tabId).toBe('tab-1')
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'claude' })
    )
    expect(mockLaunchStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('shows rejected prompt delivery in chat after Codex becomes ready', async () => {
    const error = new Error('prompt transport rejected')
    mockPasteDraftWhenAgentReady.mockRejectedValue(error)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).rejects.toBe(error)
    expect(mockMarkNativeChatLaunchPromptFailed).toHaveBeenCalledWith('tab-1')
    expect(mockSetTabViewMode).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)('keeps an SSH %s tab on the bridge', async (agent) => {
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent, worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: agent,
      viewMode: 'chat'
    })
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)(
    'keeps a runtime-paired %s tab on the bridge',
    async (agent) => {
      store.repos = [{ id: 'repo-1', connectionId: 'runtime-ssh-a', path: '/repo' }]
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ agent, worktreeId: 'wt-1' })

      expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
        launchAgent: agent,
        viewMode: 'chat'
      })
      expect(mockWaitForAgentReady).not.toHaveBeenCalled()
    }
  )
})
