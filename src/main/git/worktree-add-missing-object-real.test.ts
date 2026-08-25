import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GIT_OBJECT_STORE_FAILURE_ANCHOR } from '../../shared/git-object-store-failure'
import { classifyWorkspaceCreateError } from '../ipc/workspace-create-error-classifier'
import { addSparseWorktree, addWorktree } from './worktree'

// Real-binary reproduction of the field report: the branch's commit object is
// present (so every commit-only preflight passes) but its root tree is gone.
// Root and Windows ignore mode 000, so the unreadable-object shape cannot be staged there.
const chmodBlocksReads = ((): boolean => {
  const probeDir = mkdtempSync(join(tmpdir(), 'orca-chmod-probe-'))
  try {
    const probe = join(probeDir, 'probe')
    writeFileSync(probe, 'x')
    chmodSync(probe, 0o000)
    try {
      readFileSync(probe)
      return false
    } catch {
      return true
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})()

describe('addWorktree real Git contract for a missing root tree', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  const buildRepoWithMissingRootTree = (): { repoPath: string } => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-missing-tree-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim()

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    // Sparse cone mode needs a real directory to select.
    mkdirSync(join(repoPath, 'pkg'))
    writeFileSync(join(repoPath, 'pkg', 'inner.txt'), 'inner\n')
    git('add', '.')
    git('commit', '-m', 'base')
    git('branch', '-M', 'main')

    const tree = git('rev-parse', 'HEAD^{tree}')
    // Detach the branch from HEAD's reflog-reachable checkout before removing the tree.
    git('branch', 'akulafb/test', 'HEAD')
    rmSync(join(repoPath, '.git', 'objects', tree.slice(0, 2), tree.slice(2)), { force: true })

    // The exact preflight Orca runs today still succeeds on this repo.
    expect(git('rev-parse', '--verify', '--quiet', 'refs/heads/akulafb/test^{commit}')).toMatch(
      /^[0-9a-f]{40}$/
    )
    return { repoPath }
  }

  it('reports a repairable object-store failure instead of leaking the path and argv', async () => {
    const { repoPath } = buildRepoWithMissingRootTree()
    const worktreePath = join(repoPath, '..', `wt-${Date.now()}`)
    tempPaths.push(worktreePath)

    const error = await addWorktree(
      repoPath,
      worktreePath,
      'akulafb/test',
      undefined,
      false,
      false,
      { checkoutExistingBranch: true }
    ).then(
      () => null,
      (thrown: unknown) => thrown as Error
    )

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
    expect(error?.message).toContain('akulafb/test')
    expect(error?.message).toContain('git fsck')
    expect(error?.message).not.toContain(worktreePath)
    expect(error?.message).not.toContain('git worktree add')
    expect(error?.message).not.toContain('Command failed')
  })

  it('reports the same failure for the new-branch form, which reads the same tree', async () => {
    const { repoPath } = buildRepoWithMissingRootTree()
    const worktreePath = join(repoPath, '..', `wt-b-${Date.now()}`)
    tempPaths.push(worktreePath)

    const error = await addWorktree(
      repoPath,
      worktreePath,
      'orca/from-broken-base',
      'akulafb/test'
    ).then(
      () => null,
      (thrown: unknown) => thrown as Error
    )

    expect(error?.message).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
    expect(error?.message).not.toContain(worktreePath)
  })

  // The sparse path never fails in `worktree add`: it passes --no-checkout, which exits 0
  // without reading the tree, and dies in the follow-up `git checkout` instead.
  it('diagnoses the sparse create, which fails in the follow-up checkout rather than in add', async () => {
    const { repoPath } = buildRepoWithMissingRootTree()
    const worktreePath = join(repoPath, '..', `wt-sparse-${Date.now()}`)
    tempPaths.push(worktreePath)

    const error = await addSparseWorktree(
      repoPath,
      worktreePath,
      'akulafb/test',
      ['pkg'],
      undefined,
      false,
      { checkoutExistingBranch: true }
    ).then(
      () => null,
      (thrown: unknown) => thrown as Error
    )

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
    expect(error?.message).toContain('akulafb/test')
    expect(error?.message).toContain('git fsck')
    // The commit really is readable here, so the specific sentence is earned.
    expect(error?.message).toContain('root tree object is missing')
    expect(error?.message).not.toContain('Command failed')
    expect(error?.message).not.toContain('git checkout')
  })

  // The inverse corruption: the ROOT TREE survives and the COMMIT is the unreadable
  // object. Git answers `fatal: invalid reference`, and both `^{commit}` and `^{tree}`
  // peels exit 1 — so a tree-only probe would wrongly report "commit present, tree gone".
  const buildRepoWithCorruptCommit = (): { repoPath: string; treeOid: string } => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-corrupt-commit-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim()

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    git('add', 'fixture.txt')
    git('commit', '-m', 'base')
    git('branch', '-M', 'main')
    git('branch', 'akulafb/test', 'HEAD')

    const commit = git('rev-parse', 'refs/heads/akulafb/test')
    const treeOid = git('rev-parse', 'refs/heads/akulafb/test^{tree}')
    const commitFile = join(repoPath, '.git', 'objects', commit.slice(0, 2), commit.slice(2))
    chmodSync(commitFile, 0o644)
    writeFileSync(commitFile, '')

    // The tree really is still on disk; only the commit is unreadable.
    expect(git('cat-file', '-t', treeOid)).toBe('tree')
    return { repoPath, treeOid }
  }

  it('does not claim the commit survived when git could not read the commit', async () => {
    const { repoPath } = buildRepoWithCorruptCommit()
    const worktreePath = join(repoPath, '..', `wt-c-${Date.now()}`)
    tempPaths.push(worktreePath)

    const error = await addWorktree(
      repoPath,
      worktreePath,
      'akulafb/test',
      undefined,
      false,
      false,
      { checkoutExistingBranch: true }
    ).then(
      () => null,
      (thrown: unknown) => thrown as Error
    )

    expect(error?.message).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
    // Both halves of the specific sentence would be false here.
    expect(error?.message).not.toContain('root tree object is missing')
    expect(error?.message).not.toContain('is present but')
    expect(error?.message).toContain('Git could not read every object')
  })

  // The everyday shape of a repo written by `sudo git`, a root-owned bind mount, or a
  // bad-umask share: the tree object is right there on disk and Git may not open it.
  const buildRepoWithUnreadableRootTree = (): { repoPath: string; treeOid: string } => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-unreadable-tree-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim()

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    git('add', 'fixture.txt')
    git('commit', '-m', 'base')
    git('branch', '-M', 'main')
    git('branch', 'akulafb/test', 'HEAD')

    const treeOid = git('rev-parse', 'refs/heads/akulafb/test^{tree}')
    const treeFile = join(repoPath, '.git', 'objects', treeOid.slice(0, 2), treeOid.slice(2))
    chmodSync(treeFile, 0o000)
    return { repoPath, treeOid }
  }

  it.skipIf(!chmodBlocksReads)(
    'does not report an unreadable root tree as a missing one',
    async () => {
      const { repoPath, treeOid } = buildRepoWithUnreadableRootTree()
      const worktreePath = join(repoPath, '..', `wt-eacces-${Date.now()}`)
      tempPaths.push(worktreePath)

      const error = await addWorktree(
        repoPath,
        worktreePath,
        'akulafb/test',
        undefined,
        false,
        false,
        { checkoutExistingBranch: true }
      ).then(
        () => null,
        (thrown: unknown) => thrown as Error
      )

      // The object it supposedly lost is still on disk, byte for byte.
      chmodSync(join(repoPath, '.git', 'objects', treeOid.slice(0, 2), treeOid.slice(2)), 0o444)
      expect(
        execFileSync('git', ['cat-file', '-t', treeOid], { cwd: repoPath, encoding: 'utf8' }).trim()
      ).toBe('tree')

      expect(error?.message).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
      expect(error?.message).not.toContain('root tree object is missing')
      expect(error?.message).toContain('Git could not read every object')
    }
  )

  it.skipIf(!chmodBlocksReads)(
    'keeps an unreadable-object create in the permission_denied telemetry bucket',
    async () => {
      const { repoPath } = buildRepoWithUnreadableRootTree()
      const worktreePath = join(repoPath, '..', `wt-eacces-class-${Date.now()}`)
      tempPaths.push(worktreePath)

      const error = await addWorktree(
        repoPath,
        worktreePath,
        'akulafb/test',
        undefined,
        false,
        false,
        { checkoutExistingBranch: true }
      ).then(
        () => null,
        (thrown: unknown) => thrown as Error
      )

      expect(classifyWorkspaceCreateError(error)).toBe('permission_denied')
    }
  )
})
