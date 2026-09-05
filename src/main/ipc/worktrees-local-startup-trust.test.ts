import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from './worktree-logic'
import { listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

const { markCodexProjectTrustedMock } = vi.hoisted(() => ({
  markCodexProjectTrustedMock: vi.fn()
}))
vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted: markCodexProjectTrustedMock,
  markCopilotFolderTrusted: vi.fn(),
  markCursorWorkspaceTrusted: vi.fn()
}))

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
  return (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(actual)
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

describe('local staged startup trust', () => {
  let runtimeStub: WorktreeRuntimeStub
  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
    markCodexProjectTrustedMock.mockReset()
  })

  it.each(['resolve', 'reject'] as const)(
    'waits for Codex trust before staged startup when the write will %s',
    async (outcome) => {
      listWorktreesMock.mockResolvedValueOnce([
        {
          path: '/workspace/improve-dashboard',
          branch: 'improve-dashboard',
          head: 'def',
          isBare: false,
          isMainWorktree: false
        }
      ])
      let finish!: () => void
      const trustWrite = new Promise<void>((resolve, reject) => {
        finish = () => (outcome === 'resolve' ? resolve() : reject(new Error('write failed')))
      })
      markCodexProjectTrustedMock.mockReturnValueOnce(trustWrite)
      const creation = handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard',
        createdWithAgent: 'codex',
        startup: { command: 'codex' }
      })
      try {
        await vi.waitFor(() => {
          expect(markCodexProjectTrustedMock).toHaveBeenCalledWith('/workspace/improve-dashboard')
        })
        expect(runtimeStub.createTerminal).not.toHaveBeenCalled()
      } finally {
        finish()
        await creation
      }
      expect(runtimeStub.createTerminal).toHaveBeenCalledTimes(1)
      await expect(creation).resolves.toMatchObject({ startupTerminal: { spawned: true } })
    }
  )
})
