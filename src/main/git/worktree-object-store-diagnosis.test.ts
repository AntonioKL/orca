import { describe, expect, it, vi } from 'vitest'
import { diagnoseWorktreeObjectStore } from './worktree-object-store-diagnosis'

const execError = (code: number | undefined): Error =>
  Object.assign(new Error('Command failed'), code === undefined ? {} : { code })

// Real runners put git's stderr on `message` (execFile) or a `stderr` field (relay).
const execErrorWithStderr = (code: number, stderr: string): Error =>
  Object.assign(new Error(stderr.trim()), { code, stderr })

describe('diagnoseWorktreeObjectStore', () => {
  it('reports the root tree missing only when git itself answered "no such object"', async () => {
    const runGit = vi.fn(async () => {
      // A genuinely absent object: `--quiet` exits 1 saying nothing at all.
      throw execError(1)
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/akulafb/test')).resolves.toEqual({
      commit: 'missing',
      rootTree: 'missing',
      partialClone: 'no'
    })
    expect(runGit).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/akulafb/test^{tree}'
    ])
  })

  it('never turns "we could not run the probe" into "the object is absent"', async () => {
    // Dead SSH transport / killed process: no git exit status at all.
    const runGit = vi.fn(async () => {
      throw execError(undefined)
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toEqual({
      commit: 'unverifiable',
      rootTree: 'unverifiable',
      partialClone: 'unverifiable'
    })
  })

  it('treats a non-1 git exit status as unverifiable rather than missing', async () => {
    const runGit = vi.fn(async () => {
      throw execError(128)
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toEqual({
      commit: 'unverifiable',
      rootTree: 'unverifiable',
      partialClone: 'unverifiable'
    })
  })

  it('does not call an object "missing" when git said it could not READ it', async () => {
    // Real git 2.44, tree object on disk at mode 000: the peel exits 1 AND prints why.
    const runGit = vi.fn(async (args: string[]) => {
      if (args[3] === 'refs/heads/feat^{commit}') {
        return { stdout: '9116c0f36c8838ea180a19d9d66e3d1fbc7bb5d9\n' }
      }
      throw execErrorWithStderr(
        1,
        'error: unable to open loose object ba856f78f34fcefae5d72ef4aec60e70a52ea4a0: Permission denied\n'
      )
    })

    const diagnosis = await diagnoseWorktreeObjectStore(runGit, 'refs/heads/feat')

    expect(diagnosis.commit).toBe('present')
    expect(diagnosis.rootTree).toBe('unverifiable')
  })

  it('does not call an object "missing" when the peel tripped over a corrupt file', async () => {
    // Real git 2.44 with the commit object truncated to zero bytes.
    const runGit = vi.fn(async () => {
      throw execErrorWithStderr(
        1,
        'error: object file .git/objects/cc/e159f9d17b185c6da8513db0a7a4d4f8d6585a is empty\n'
      )
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/feat')).resolves.toEqual({
      commit: 'unverifiable',
      rootTree: 'unverifiable',
      partialClone: 'unverifiable'
    })
  })

  it('observes a promisor remote as a partial clone', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'ba856f78f34fcefae5d72ef4aec60e70a52ea4a0\n' }
      }
      return { stdout: 'remote.origin.promisor true\n' }
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toEqual({
      commit: 'present',
      rootTree: 'present',
      partialClone: 'yes'
    })
    expect(runGit).toHaveBeenCalledWith(['config', '--get-regexp', '^remote\\..*\\.promisor$'])
  })

  it('does not read a silent exit 0 as proof the object is there or gone', async () => {
    // A wrapper that swallowed stdout (fenced WSL login shell, truncated relay frame) proves nothing.
    const runGit = vi.fn(async () => ({ stdout: '' }))

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toEqual({
      commit: 'unverifiable',
      rootTree: 'unverifiable',
      partialClone: 'unverifiable'
    })
  })

  it('reads an explicitly disabled promisor remote as not a partial clone', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'ba856f78f34fcefae5d72ef4aec60e70a52ea4a0\n' }
      }
      return { stdout: 'remote.origin.promisor false\n' }
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toMatchObject({
      partialClone: 'no'
    })
  })

  it("reads Git's valueless boolean form as a promisor remote", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'ba856f78f34fcefae5d72ef4aec60e70a52ea4a0\n' }
      }
      return { stdout: 'remote.origin.promisor\n' }
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toMatchObject({
      partialClone: 'yes'
    })
  })

  it('probes the commit too, so an unreadable commit is not read as a missing tree', async () => {
    // Both peels answer a wordless "no", so the commit is absent rather than unreadable.
    const runGit = vi.fn(async (_args: string[]) => {
      throw execError(1)
    })

    const diagnosis = await diagnoseWorktreeObjectStore(runGit, 'refs/heads/akulafb/test')

    expect(diagnosis.commit).toBe('missing')
    expect(runGit).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/akulafb/test^{commit}'
    ])
  })

  it('observes the commit present when only the tree peel fails', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[3] === 'refs/heads/x^{commit}') {
        return { stdout: 'c8a40a3a1ebd165bbdc29303e8c0e7330442abaa\n' }
      }
      throw execError(1)
    })

    await expect(diagnoseWorktreeObjectStore(runGit, 'refs/heads/x')).resolves.toEqual({
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'no'
    })
  })
})
