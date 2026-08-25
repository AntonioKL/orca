import { describe, expect, it, vi } from 'vitest'
import { describeWorktreeAddObjectStoreFailure } from './worktree-add-object-store-error'

// Node's execFile glues git's stderr onto the argv line; this is what both the local
// runner and the SSH relay hand back for the reported failure.
const rawLocalError = new Error(
  "Command failed: git worktree add /Users/akulafb/dev/worktrees/test 'akulafb/test'\n" +
    "Preparing worktree (checking out 'akulafb/test')\n" +
    'fatal: unable to read tree (041335168f0214913840aaaaaaaaaaaaaaaaaaaa)'
)

describe('describeWorktreeAddObjectStoreFailure', () => {
  it('leaves unrelated failures for the caller to rethrow untouched', async () => {
    const runGit = vi.fn()
    const unrelated = new Error(
      "Command failed: git worktree add /Users/akulafb/wt\nfatal: 'wt' already exists"
    )

    await expect(
      describeWorktreeAddObjectStoreFailure(unrelated, {
        runGit,
        branch: 'akulafb/test',
        checkoutRef: 'refs/heads/akulafb/test'
      })
    ).resolves.toBeNull()
    expect(runGit).not.toHaveBeenCalled()
  })

  it('does not re-diagnose an error a caller already described', async () => {
    // The sparse path funnels addWorktree failures through the same catch.
    const runGit = vi.fn()
    const alreadyDescribed = await describeWorktreeAddObjectStoreFailure(rawLocalError, {
      runGit: async () => {
        throw Object.assign(new Error('Command failed'), { code: 1 })
      },
      branch: 'akulafb/test',
      checkoutRef: 'refs/heads/akulafb/test'
    })

    await expect(
      describeWorktreeAddObjectStoreFailure(alreadyDescribed, {
        runGit,
        branch: 'akulafb/test',
        checkoutRef: 'refs/heads/akulafb/test'
      })
    ).resolves.toBeNull()
    expect(runGit).not.toHaveBeenCalled()
  })

  it('reads git fatals that arrive only on a separate stderr field', async () => {
    const stderrOnly = Object.assign(new Error('Command failed with exit code 128'), {
      stderr: 'fatal: unable to read tree 041335168f0214913840aaaaaaaaaaaaaaaaaaaa\n'
    })

    const described = await describeWorktreeAddObjectStoreFailure(stderrOnly, {
      runGit: async () => {
        throw Object.assign(new Error('Command failed'), { code: 1 })
      },
      branch: 'akulafb/test',
      checkoutRef: 'refs/heads/akulafb/test'
    })

    expect(described?.message).toContain('repository object database is missing objects')
  })

  it('probes the checked-out ref and redacts the path and argv', async () => {
    // The reported shape: the commit peels, the tree does not.
    const runGit = vi.fn(async (args: string[]) =>
      args[3] === 'refs/heads/akulafb/test^{commit}'
        ? { stdout: 'c8a40a3a1ebd165bbdc29303e8c0e7330442abaa\n' }
        : Promise.reject(Object.assign(new Error('Command failed'), { code: 1 }))
    )

    const described = await describeWorktreeAddObjectStoreFailure(rawLocalError, {
      runGit,
      branch: 'akulafb/test',
      checkoutRef: 'refs/heads/akulafb/test'
    })

    expect(runGit).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/akulafb/test^{tree}'
    ])
    expect(described?.message).toContain('root tree object is missing')
    expect(described?.message).not.toContain('/Users/akulafb')
    expect(described?.message).not.toContain('git worktree add')
    // The raw argv stays reachable for main-process logs and telemetry.
    expect(described?.cause).toBe(rawLocalError)
  })

  it('falls back to the generic sentence when the commit is unreadable too', async () => {
    // Both peels answer a wordless "no": the commit is gone too, so neither half is observed.
    const runGit = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1 })
    })

    const described = await describeWorktreeAddObjectStoreFailure(rawLocalError, {
      runGit,
      branch: 'akulafb/test',
      checkoutRef: 'refs/heads/akulafb/test'
    })

    expect(described?.message).not.toContain('root tree object is missing')
    expect(described?.message).toContain('Git could not read every object')
  })

  it('still describes the failure when the SSH relay cannot run the probes', async () => {
    // Relay errors carry no git exit status, so nothing may be claimed about the tree.
    const runGit = vi.fn(async () => {
      throw new Error('SSH connection is not available. Please reconnect and try again.')
    })

    const described = await describeWorktreeAddObjectStoreFailure(rawLocalError, {
      runGit,
      branch: 'akulafb/test',
      checkoutRef: 'refs/heads/akulafb/test'
    })

    expect(described?.message).toContain('repository object database is missing objects')
    expect(described?.message).not.toContain('root tree object is missing')
    expect(described?.message).not.toContain('partial clone')
    expect(described?.message).not.toContain('/Users/akulafb')
  })

  it('adds promisor guidance when the remote host reports a partial clone', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw Object.assign(new Error('Command failed'), { code: 1 })
      }
      return { stdout: 'remote.origin.promisor true\n' }
    })

    const described = await describeWorktreeAddObjectStoreFailure(rawLocalError, {
      runGit,
      branch: 'akulafb/test',
      checkoutRef: 'refs/heads/akulafb/test'
    })

    expect(described?.message).toContain('partial clone')
    expect(described?.message).toContain('git fetch --refetch')
  })
})
