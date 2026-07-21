import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorktreeRebaseState } from './worktree'

describe('readWorktreeRebaseState (local/native path)', () => {
  const tmpDirs: string[] = []

  function makeWorktree(): { worktreePath: string; gitDir: string } {
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'orca-local-rebase-'))
    tmpDirs.push(worktreePath)
    return { worktreePath, gitDir: path.join(worktreePath, '.git') }
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('recovers the branch from rebase-merge/head-name', async () => {
    const { worktreePath, gitDir } = makeWorktree()
    await fs.mkdir(path.join(gitDir, 'rebase-merge'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/feature/x\n')

    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: true,
      rebaseBranch: 'feature/x'
    })
  })

  it('rejects a git am (rebase-apply without the rebasing sentinel)', async () => {
    const { worktreePath, gitDir } = makeWorktree()
    await fs.mkdir(path.join(gitDir, 'rebase-apply'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'rebase-apply', 'applying'), '')
    await fs.writeFile(path.join(gitDir, 'rebase-apply', 'head-name'), 'refs/heads/ignored\n')

    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: false,
      rebaseBranch: null
    })
  })

  it('reports not rebasing when there is no rebase directory', async () => {
    const { worktreePath } = makeWorktree()
    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: false,
      rebaseBranch: null
    })
  })

  it('resolves a linked worktree gitdir (.git file pointer)', async () => {
    const { worktreePath } = makeWorktree()
    const realGitDir = mkdtempSync(path.join(tmpdir(), 'orca-local-rebase-gitdir-'))
    tmpDirs.push(realGitDir)
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${realGitDir}\n`)
    await fs.mkdir(path.join(realGitDir, 'rebase-merge'), { recursive: true })
    await fs.writeFile(
      path.join(realGitDir, 'rebase-merge', 'head-name'),
      'refs/heads/linked/topic\n'
    )

    expect(await readWorktreeRebaseState(worktreePath)).toEqual({
      rebasing: true,
      rebaseBranch: 'linked/topic'
    })
  })
})
