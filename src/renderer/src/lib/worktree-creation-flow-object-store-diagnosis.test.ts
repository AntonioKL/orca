import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

// Split from worktree-creation-flow.test.ts: the background create path's handling of a
// diagnosed object-store failure, where the pending entry is the only surface the user reads.

type TestActiveView = 'terminal' | 'tasks'

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    experimentalNativeChat: undefined as boolean | undefined,
    openAgentTabsInChatByDefault: undefined as boolean | undefined
  },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [] as { id: string; connectionId: string | null }[],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
    store.activePendingCreationId = entry.creationId
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {})),
  setupProjectExistingFolder: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: vi.fn()
}))

import { toast } from 'sonner'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import {
  continueBackgroundWorktreeCreation,
  retryBackgroundWorktreeCreation
} from './worktree-creation-flow'

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function makePendingCreation(request: WorktreeCreationRequest): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request
  }
}

async function flushAsyncWorktreeCreation(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.activeView = 'terminal'
  store.activePendingCreationId = 'creation-1'
  store.repos = []
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
  store.tabsByWorktree = {}
  store.unifiedTabsByWorktree = {}
  vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
})

describe('staged background worktree creation on an object-store failure', () => {
  it('keeps the actionable diagnosis on the pending entry while the toast stays short', async () => {
    store.activeView = 'tasks'
    store.createWorktree.mockRejectedValueOnce(
      new Error(
        'Orca could not create this workspace because the repository object database is missing objects. ' +
          'Git reported: unable to read tree (041335168f0214913840aaaaaaaaaaaaaaaaaaaa). ' +
          'Run git fsck in the repository to confirm what is missing, then re-fetch from the remote or re-clone to restore it.'
      )
    )

    const started = continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })

    expect(started).toBe(true)
    await flushAsyncWorktreeCreation()
    // The panel is the only surface the user gets, so it must carry the oid and the repair command.
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        status: 'error',
        error: 'Repository objects are missing',
        errorDetail: expect.stringContaining('git fsck')
      })
    )
    const detail = store.updatePendingWorktreeCreation.mock.calls.at(-1)?.[1]?.errorDetail ?? ''
    expect(detail).toContain('041335168f0214913840aaaaaaaaaaaaaaaaaaaa')
    expect(toast.error).toHaveBeenCalledWith('Repository objects are missing')
  })

  it('surfaces the sparse path failure, which git words as an unparsable commit', async () => {
    store.activeView = 'tasks'
    // Verbatim git 2.44.0 stderr for a sparse create whose root tree is gone: the failure
    // lands in the follow-up `git checkout`, not in `worktree add --no-checkout`.
    store.createWorktree.mockRejectedValueOnce(
      new Error(
        'Command failed: git checkout akulafb/test\n' +
          'fatal: unable to parse commit 435b1d6c622920a72b8984ec55742106c5434436'
      )
    )

    continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })
    await flushAsyncWorktreeCreation()

    const detail = store.updatePendingWorktreeCreation.mock.calls.at(-1)?.[1]?.errorDetail ?? ''
    expect(detail).toContain('unable to parse commit 435b1d6c622920a72b8984ec55742106c5434436')
    expect(detail).not.toContain('Command failed')
    expect(toast.error).toHaveBeenCalledWith('Repository objects are missing')
  })

  it('clears the previous diagnosis when a retry starts', async () => {
    store.createWorktree.mockRejectedValueOnce(
      new Error(
        'Orca could not create this workspace because the repository object database is missing objects. ' +
          'Run git fsck in the repository to confirm what is missing.'
      )
    )
    continueBackgroundWorktreeCreation('creation-1', makeRequest(), {
      revealCreationSurface: false
    })
    await flushAsyncWorktreeCreation()
    expect(store.pendingWorktreeCreations['creation-1']?.errorDetail).toContain('git fsck')

    retryBackgroundWorktreeCreation('creation-1')

    // Why: the panel prefers errorDetail, so a stale one would outlive the failure it described.
    expect(store.pendingWorktreeCreations['creation-1']?.errorDetail).toBeUndefined()
  })
})
