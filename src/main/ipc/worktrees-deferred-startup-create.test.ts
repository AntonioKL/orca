import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from './worktree-logic'
import { addWorktreeMock, listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
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
vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeLogic>()
  return {
    ...(await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(actual),
    computeWorkspaceRootAsync: vi.fn(actual.computeWorkspaceRootAsync)
  }
})
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

const supportsDeferredStartupMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./pty/runtime/deferred-startup', () => ({
  supportsDeferredStartupFromRuntimeController: supportsDeferredStartupMock,
  releaseStartupFromRuntimeController: vi.fn()
}))

describe('deferred composer startup creation', () => {
  let runtimeStub: WorktreeRuntimeStub
  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
    supportsDeferredStartupMock.mockResolvedValue(true)
  })
  function stubStartupWorktreeListing(): void {
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard',
        head: 'def',
        isBare: false,
        isMainWorktree: false
      }
    ])
  }

  it.each(['incarnation', undefined])(
    'preserves the held operation with incarnation %s',
    async (incarnationId) => {
      addWorktreeMock.mockResolvedValue({})
      stubStartupWorktreeListing()
      runtimeStub.createTerminal.mockResolvedValueOnce({
        handle: 'term-startup',
        ptyId: 'pty',
        incarnationId
      })
      const result = (await handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard',
        startup: {
          command: 'claude',
          activate: false,
          deferredStartupOperationId: 'operation',
          launchToken: 'operation'
        }
      })) as CreateWorktreeResult
      expect(runtimeStub.createTerminal).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          command: 'claude',
          deferredStartupOperationId: 'operation',
          launchToken: 'operation',
          activate: false,
          surfaceOwner: false
        })
      )
      expect(result.startupTerminal).toMatchObject({
        ptyId: 'pty',
        deferredStartup: { operationId: 'operation', incarnationId: incarnationId ?? null }
      })
    }
  )

  it('keeps checkout-only preparation when provider capability changed before spawn', async () => {
    supportsDeferredStartupMock.mockResolvedValue(false)
    addWorktreeMock.mockResolvedValue({})
    stubStartupWorktreeListing()
    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      startup: { command: 'claude', activate: false, deferredStartupOperationId: 'operation' }
    })) as CreateWorktreeResult
    expect(runtimeStub.createTerminal).not.toHaveBeenCalled()
    expect(result.startupTerminal).toBeUndefined()
    expect(result.worktree).toBeDefined()
  })
})
