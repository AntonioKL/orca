import { describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { makeRequest } from './worktree-creation-request.test-fixture'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { activateAndRevealWorktree } from './worktree-activation'

const { store } = vi.hoisted(() => ({
  store: {
    createWorktree: vi.fn(),
    pendingWorktreeCreations: { 'creation-1': {} },
    activeView: 'terminal',
    activePendingCreationId: 'creation-1'
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'creation-1' }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/agent-trust-preflight', () => ({ preflightAgentTrust: vi.fn() }))
vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  attachEphemeralVmRuntimeToWorkspace: vi.fn(),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn(),
  prepareRequestForCreate: vi.fn()
}))
vi.mock('@/lib/worktree-creation-structured-session', () => ({
  launchStructuredWorktreeSession: vi.fn()
}))
vi.mock('@/lib/worktree-creation-structured-recovery', () => ({
  markStructuredWorktreeLaunchUnconfirmed: vi.fn()
}))
vi.mock('@/lib/worktree-creation-completion', () => ({ completeWorktreeCreation: vi.fn() }))

describe('retained agent activation', () => {
  it('launches the selected agent from a retained checkout without creating again', async () => {
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce({ primaryTabId: 'agent-tab' })
    const launchConfig = { agentArgs: '--model selected', agentEnv: { PROJECT: 'fixture' } }
    const request = makeRequest({
      agent: 'codex',
      launchDraftPrompt: 'Unsent task',
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex --model selected',
        expectedProcess: 'codex',
        followupPrompt: null,
        draftPrompt: 'Unsent task',
        env: { PROJECT: 'fixture' },
        launchConfig
      }
    })
    await executeWorktreeCreation('creation-1', request, {
      worktree: { id: 'wt-agent', repoId: 'repo-1' }
    } as CreateWorktreeResult)
    expect(store.createWorktree).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('wt-agent', {
      sidebarRevealBehavior: 'auto',
      startup: {
        command: 'codex --model selected',
        launchAgent: 'codex',
        env: { PROJECT: 'fixture' },
        launchConfig,
        launchToken: 'creation-1',
        draftPrompt: 'Unsent task',
        launchDraftText: 'Unsent task'
      }
    })
  })
})
