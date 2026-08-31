import { describe, expect, it, vi } from 'vitest'
import { spawnLocalStartupAndSetupTerminals } from './worktree-remote'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('spawnLocalStartupAndSetupTerminals', () => {
  it('can provision setup without a startup terminal for seed completion observation', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      handle: 'term-setup-only',
      surface: 'visible'
    })
    const waitForSetupTerminalCompletion = vi.fn().mockResolvedValue({ exitCode: 0 })
    const onSetupCompleted = vi.fn()
    const runtime = {
      createTerminal,
      splitTerminal: vi.fn(),
      waitForSetupTerminalCompletion
    } as never

    const result = await spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree: { id: 'repo-1::/workspace/setup-only', path: '/workspace/setup-only' },
      startup: undefined,
      setup: {
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
        envVars: {}
      },
      defaultTabs: undefined,
      settings: { setupScriptLaunchMode: 'new-tab' } as never,
      createdWithAgent: undefined,
      forceSetupProvision: true,
      onSetupCompleted
    })

    expect(result).toMatchObject({
      didSpawnSetup: true,
      setupTerminalHandle: 'term-setup-only'
    })
    expect(createTerminal).toHaveBeenCalledWith(
      'id:repo-1::/workspace/setup-only',
      expect.objectContaining({
        title: 'Setup',
        command: expect.stringContaining('__ORCA_SETUP_COMPLETE__:'),
        activate: false
      })
    )
    const setupOptions = createTerminal.mock.calls[0]?.[1] as { command?: string }
    const completionToken = setupOptions.command?.match(
      /__ORCA_SETUP_COMPLETE__:([^:]+):%s\\n/
    )?.[1]
    expect(completionToken).toEqual(expect.any(String))
    expect(waitForSetupTerminalCompletion).toHaveBeenCalledWith('term-setup-only', completionToken)
    await vi.waitFor(() => expect(onSetupCompleted).toHaveBeenCalledWith(0))
  })

  it('falls back to a setup tab when seed-observing split setup has no primary terminal', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      handle: 'term-setup-split-fallback',
      surface: 'visible'
    })
    const splitTerminal = vi.fn()
    const runtime = { createTerminal, splitTerminal } as never

    const result = await spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree: { id: 'repo-1::/workspace/setup-split', path: '/workspace/setup-split' },
      startup: undefined,
      setup: {
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
        envVars: {}
      },
      defaultTabs: undefined,
      settings: { setupScriptLaunchMode: 'split-vertical' } as never,
      createdWithAgent: undefined,
      forceSetupProvision: true
    })

    expect(result.setupTerminalHandle).toBe('term-setup-split-fallback')
    expect(splitTerminal).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      'id:repo-1::/workspace/setup-split',
      expect.objectContaining({ title: 'Setup' })
    )
  })

  it('materializes default tabs when seed ownership bypasses renderer activation', async () => {
    const createTerminal = vi
      .fn()
      .mockResolvedValueOnce({ handle: 'term-startup', surface: 'visible' })
      .mockResolvedValueOnce({ handle: 'term-default', tabId: 'tab-default', surface: 'visible' })
      .mockResolvedValueOnce({ handle: 'term-setup', surface: 'visible' })
    const setMobileSessionTabProps = vi.fn().mockResolvedValue({ updated: true })
    const runtime = {
      createTerminal,
      splitTerminal: vi.fn(),
      setMobileSessionTabProps,
      waitForSetupTerminalCompletion: vi.fn()
    } as never

    const result = await spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree: { id: 'repo-1::/workspace/seeded-defaults', path: '/workspace/seeded-defaults' },
      startup: { command: 'agent' },
      setup: {
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
        envVars: {}
      },
      defaultTabs: {
        runCommands: true,
        tabs: [{ title: 'Dev', command: 'pnpm dev', color: '#123456' }]
      },
      settings: { setupScriptLaunchMode: 'new-tab' } as never,
      createdWithAgent: undefined,
      forceSetupProvision: true,
      materializeDefaultTabs: true
    })

    expect(result).toMatchObject({
      didSpawnDefaultTabs: true,
      didSpawnSetup: true,
      startupTerminal: { spawned: true }
    })
    expect(createTerminal).toHaveBeenNthCalledWith(2, 'id:repo-1::/workspace/seeded-defaults', {
      title: 'Dev',
      command: 'pnpm dev',
      activate: false
    })
    expect(setMobileSessionTabProps).toHaveBeenCalledWith('id:repo-1::/workspace/seeded-defaults', {
      tabId: 'tab-default',
      color: '#123456'
    })
  })

  it('leaves default tabs available when every host spawn fails', async () => {
    const createTerminal = vi.fn().mockRejectedValue(new Error('pty unavailable'))
    const runtime = {
      createTerminal,
      splitTerminal: vi.fn(),
      waitForSetupTerminalCompletion: vi.fn()
    } as never

    const result = await spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree: { id: 'repo-1::/workspace/default-fallback', path: '/workspace/default-fallback' },
      startup: undefined,
      setup: undefined,
      defaultTabs: {
        runCommands: true,
        tabs: [{ title: 'Dev', command: 'pnpm dev' }]
      },
      settings: { setupScriptLaunchMode: 'new-tab' } as never,
      createdWithAgent: undefined,
      materializeDefaultTabs: true
    })

    expect(result.didSpawnDefaultTabs).toBeUndefined()
    expect(result.warning).toContain('failed to create a default terminal')
  })
})
