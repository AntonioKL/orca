import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { makePendingCreation, makeRequest } from './worktree-creation-request.test-fixture'

const store = {
  settings: { activeRuntimeEnvironmentId: null },
  activeView: 'terminal',
  activePendingCreationId: 'creation-1',
  repos: [{ id: 'repo-1', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  updatePendingWorktreeCreation: vi.fn((id: string, patch: Partial<PendingWorktreeCreation>) => {
    const entry = store.pendingWorktreeCreations[id]
    if (entry) {
      store.pendingWorktreeCreations[id] = { ...entry, ...patch }
    }
  }),
  removePendingWorktreeCreation: vi.fn((id: string) => {
    delete store.pendingWorktreeCreations[id]
  }),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {},
  unifiedTabsByWorktree: {}
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => ({ primaryTabId: 'unrelated-default-tab' }))
}))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'
import { activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import { ensureAgentStartupInTerminal } from './new-workspace'

const releaseStartup = vi.fn()
const markTrusted = vi.fn()
const request = makeRequest({
  agent: 'codex',
  startupPlan: {
    agent: 'codex',
    launchCommand: 'codex',
    expectedProcess: 'codex',
    followupPrompt: null,
    launchConfig: { agentArgs: '', agentEnv: {} }
  }
})
const retained = {
  worktree: { id: 'wt-ready', repoId: 'repo-1', path: '/repo/ready' },
  startupTerminal: {
    spawned: true,
    tabId: 'held-agent-tab',
    ptyId: 'held-pty',
    deferredStartup: { operationId: 'held-operation', incarnationId: 'held-incarnation' }
  }
} as CreateWorktreeResult
const releaseIdentity = {
  worktreeId: 'wt-ready',
  ptyId: 'held-pty',
  expectedIncarnationId: 'held-incarnation',
  operationId: 'held-operation'
}

beforeEach(() => {
  vi.clearAllMocks()
  releaseStartup.mockReset().mockResolvedValue('accepted')
  markTrusted.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { worktrees: { releaseStartup }, agentTrust: { markTrusted } } })
  store.activeView = 'terminal'
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(structuredClone(request)) }
})

describe('retained agent release through worktree creation', () => {
  it('waits for trust before release and activates without queuing a second launch', async () => {
    let finishTrust!: () => void
    markTrusted.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTrust = resolve
        })
    )
    const creation = executeWorktreeCreation('creation-1', structuredClone(request), retained)
    await vi.waitFor(() => expect(markTrusted).toHaveBeenCalledOnce())
    expect(releaseStartup).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    finishTrust()
    await creation
    expect(releaseStartup).toHaveBeenCalledExactlyOnceWith(releaseIdentity)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-ready', {
      sidebarRevealBehavior: 'auto',
      backendStartupTerminalSpawned: true
    })
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(store.createWorktree).not.toHaveBeenCalled()
    expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined()
  })

  it('does not release a create canceled while trust is pending', async () => {
    let finishTrust!: () => void
    markTrusted.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTrust = resolve
        })
    )
    const creation = executeWorktreeCreation('creation-1', structuredClone(request), retained)
    await vi.waitFor(() => expect(markTrusted).toHaveBeenCalledOnce())
    delete store.pendingWorktreeCreations['creation-1']
    finishTrust()
    await creation
    expect(releaseStartup).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })

  it('does not revive a create canceled while its release acknowledgement is pending', async () => {
    let acknowledge!: (result: string) => void
    releaseStartup.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          acknowledge = resolve
        })
    )
    const creation = executeWorktreeCreation('creation-1', structuredClone(request), retained)
    await vi.waitFor(() => expect(releaseStartup).toHaveBeenCalledOnce())
    delete store.pendingWorktreeCreations['creation-1']
    acknowledge('accepted')
    await creation
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('retains an unconfirmed prepared terminal without falling back when its incarnation is missing', async () => {
    const unknown = structuredClone(retained)
    unknown.startupTerminal!.deferredStartup!.incarnationId = null
    await executeWorktreeCreation('creation-1', structuredClone(request), unknown)
    expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'error',
      deferredStartupRecovery: unknown,
      error: 'Could not verify the prepared terminal. Your workspace is saved; open it to continue.'
    })
    expect(releaseStartup).not.toHaveBeenCalled()
    expect(store.createWorktree).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('holds the saved workspace when an older renderer bridge lacks release support', async () => {
    vi.stubGlobal('window', { api: { worktrees: {}, agentTrust: { markTrusted } } })
    await executeWorktreeCreation('creation-1', structuredClone(request), retained)
    expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'error',
      deferredStartupRecovery: retained
    })
    expect(store.createWorktree).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it.each(['unverifiable', 'retired', 'identity-mismatch', 'unavailable', 'disconnect'])(
    'retains the exact workspace on %s and retries release without creating or typing a fallback',
    async (outcome) => {
      if (outcome === 'disconnect') {
        releaseStartup.mockRejectedValueOnce(new Error('connection lost'))
      } else {
        releaseStartup.mockResolvedValueOnce(outcome)
      }
      await executeWorktreeCreation('creation-1', structuredClone(request), retained)
      expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
        status: 'error',
        deferredStartupRecovery: retained
      })
      expect(activateAndRevealWorktree).not.toHaveBeenCalled()
      expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
      expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
      retryBackgroundWorktreeCreation('creation-1')
      await vi.waitFor(() => expect(store.pendingWorktreeCreations['creation-1']).toBeUndefined())
      expect(releaseStartup.mock.calls).toEqual([[releaseIdentity], [releaseIdentity]])
      expect(store.createWorktree).not.toHaveBeenCalled()
      expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    }
  )

  it('delivers followup context to the held agent tab with its original launch token', async () => {
    const withFollowup = structuredClone(request)
    withFollowup.startupPlan!.followupPrompt = 'Investigate the issue'
    const snapshot = structuredClone(withFollowup)
    await executeWorktreeCreation('creation-1', withFollowup, retained)
    expect(ensureAgentStartupInTerminal).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'wt-ready',
      primaryTabId: 'held-agent-tab',
      startup: { ...snapshot.startupPlan, launchToken: 'held-operation' }
    })
    expect(withFollowup).toEqual(snapshot)
    expect(store.createWorktree).not.toHaveBeenCalled()
  })
})
