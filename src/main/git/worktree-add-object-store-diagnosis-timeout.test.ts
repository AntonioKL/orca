// The failure-path object-store probes must stay bounded: on a partial clone they can
// trigger a promisor fetch against an unreachable remote.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { addWorktree, WORKTREE_OBJECT_STORE_DIAGNOSIS_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('worktree add object-store diagnosis probes', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
  })

  it('bounds every diagnosis probe so a promisor fetch cannot hang the create', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree') {
        throw new Error(
          "Command failed: git worktree add /repo-feature 'feature/test'\n" +
            'fatal: unable to read tree (041335168f0214913840aaaaaaaaaaaaaaaaaaaa)'
        )
      }
      throw Object.assign(new Error('Command failed'), { code: 1 })
    })

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
        checkoutExistingBranch: true
      })
    ).rejects.toThrow('repository object database is missing objects')

    const probeCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] !== 'worktree')
    expect(probeCalls.length).toBe(3)
    for (const [, options] of probeCalls) {
      expect(typeof options.timeout).toBe('number')
      expect(options.timeout).toBe(WORKTREE_OBJECT_STORE_DIAGNOSIS_TIMEOUT_MS)
    }
    // Bounded well under the add timeout it diagnoses, so the failure stays a failure.
    expect(WORKTREE_OBJECT_STORE_DIAGNOSIS_TIMEOUT_MS).toBeLessThan(30_000)
  })
})
