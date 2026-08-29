import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))

import { resolveGitDir } from './resolve-git-dir'

describe('resolveGitDir', () => {
  beforeEach(() => {
    readFileMock.mockReset()
  })

  it('resolves a relative linked-worktree marker', async () => {
    readFileMock.mockResolvedValue('gitdir: ../main/.git/worktrees/feature\n')

    await expect(resolveGitDir('/repo/feature')).resolves.toBe('/repo/main/.git/worktrees/feature')
  })

  it('does not treat an empty gitdir marker as a metadata directory', async () => {
    readFileMock.mockResolvedValue('gitdir:   \n')

    await expect(resolveGitDir('/repo/feature')).resolves.toBeNull()
  })

  it('uses the .git directory when the marker cannot be read', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }))

    await expect(resolveGitDir('/repo')).resolves.toBe('/repo/.git')
  })
})
