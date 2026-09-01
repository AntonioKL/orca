import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcResponse } from './rpc/core'
import { FILE_METHODS } from './rpc/methods/files'
import {
  isRepositoryAdminPath,
  REPOSITORY_ADMIN_PATH_DENIED_MESSAGE
} from '../../shared/repository-admin-path'

const listedWorktrees: { path: string }[] = []

vi.mock('../git/worktree', () => {
  const listed = async () =>
    listedWorktrees.map((entry) => ({
      path: entry.path,
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: true
    }))
  return {
    listWorktrees: vi.fn(listed),
    listWorktreesStrict: vi.fn(listed)
  }
})

let repoPath = ''

function makeStore() {
  const repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  return {
    getRepo: (id: string) => (id === 'repo-1' ? repo : undefined),
    getRepos: () => [repo],
    addRepo: () => {},
    updateRepo: () => ({}) as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => ({}) as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: join(tmpdir(), 'orca-admin-path-workspaces'),
      nestWorkspaces: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
}

/** A real repository plus every name a segment-equality check must NOT catch. */
async function buildRepo(gitAsPointerFile = false): Promise<void> {
  repoPath = await mkdtemp(join(tmpdir(), 'orca-admin-path-'))
  if (gitAsPointerFile) {
    await writeFile(join(repoPath, '.git'), 'gitdir: /elsewhere/.git/worktrees/feature\n', 'utf-8')
  } else {
    await mkdir(join(repoPath, '.git', 'refs'), { recursive: true })
    await mkdir(join(repoPath, '.git', 'worktrees', 'x'), { recursive: true })
    await writeFile(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    await writeFile(join(repoPath, '.git', 'config'), '[core]\n', 'utf-8')
    await writeFile(
      join(repoPath, '.git', 'worktrees', 'x', 'gitdir'),
      '/elsewhere/.git\n',
      'utf-8'
    )
  }
  await mkdir(join(repoPath, '.github', 'workflows'), { recursive: true })
  await writeFile(join(repoPath, '.github', 'workflows', 'ci.yml'), 'on: push\n', 'utf-8')
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'src', '.gitkeep'), '', 'utf-8')
  await mkdir(join(repoPath, 'mygit'), { recursive: true })
  await writeFile(join(repoPath, 'mygit', 'note.txt'), 'not admin state\n', 'utf-8')
  await writeFile(join(repoPath, '.gitignore'), 'node_modules\n', 'utf-8')
  await writeFile(join(repoPath, '.gitattributes'), '* text=auto\n', 'utf-8')
  await writeFile(join(repoPath, '.gitmodules'), '[submodule "a"]\n', 'utf-8')
  await writeFile(join(repoPath, 'git'), 'a file literally named git\n', 'utf-8')
  await writeFile(join(repoPath, 'tracked.txt'), 'working tree content\n', 'utf-8')
  listedWorktrees.splice(0, listedWorktrees.length, { path: repoPath })
}

function dispatchFileMethod(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS } as never)
  return dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method,
    params: { worktree: `path:${repoPath}`, expectedExecutionHostId: 'local', ...params }
  })
}

function expectRefused(response: RpcResponse): void {
  expect(response.ok).toBe(false)
  expect((response as { error: { message: string } }).error.message).toBe(
    REPOSITORY_ADMIN_PATH_DENIED_MESSAGE
  )
}

/** The admin state that must be byte-identical after every refused call. */
async function readAdminState(): Promise<Record<string, string>> {
  const names = await readdir(join(repoPath, '.git'))
  const entries: Record<string, string> = {}
  for (const name of names.sort()) {
    entries[name] = existsSync(join(repoPath, '.git', name)) ? 'present' : 'missing'
  }
  entries['HEAD:content'] = await readFile(join(repoPath, '.git', 'HEAD'), 'utf-8')
  entries['config:content'] = await readFile(join(repoPath, '.git', 'config'), 'utf-8')
  return entries
}

describe('isRepositoryAdminPath', () => {
  it.each([
    '.git',
    '.git/',
    '.git//',
    '.git/config',
    '.git/worktrees/x',
    '.git/hooks/pre-commit',
    '.GIT',
    '.Git',
    '.GIT/config',
    '.git\\config',
    '.git\\worktrees\\x',
    'sub/.git',
    'sub/.git/config',
    'sub\\.git'
  ])('classifies %j as repository admin state', (path) => {
    expect(isRepositoryAdminPath(path)).toBe(true)
    expect(isRepositoryAdminPath(path, 'win32')).toBe(true)
  })

  it.each([
    '.github',
    '.github/workflows/ci.yml',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
    'src/.gitkeep',
    'git',
    'src/git',
    'mygit',
    'mygit/note.txt',
    'gitignore',
    'a.git',
    'my.gitignore',
    'tracked.txt',
    'docs/git/readme.md'
  ])('leaves %j mutable', (path) => {
    expect(isRepositoryAdminPath(path)).toBe(false)
    expect(isRepositoryAdminPath(path, 'win32')).toBe(false)
  })

  it.each(['.git.', '.git ', '.git.\\config', '.git  /config'])(
    'catches the Win32 trailing dot/space spelling %j',
    (path) => {
      expect(isRepositoryAdminPath(path, 'win32')).toBe(true)
    }
  )

  it.each([undefined, null, 42, {}, '', '   '])('fails closed on %j', (path) => {
    expect(isRepositoryAdminPath(path)).toBe(true)
  })
})

describe('files.* RPCs refuse repository admin paths', () => {
  beforeEach(async () => {
    await buildRepo()
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  // Why: this is the STA-6210 reproduction — it destroyed `.git` before the guard existed.
  it('files.delete no longer removes .git, and the working tree is untouched', async () => {
    const before = await readAdminState()

    const response = await dispatchFileMethod('files.delete', {
      relativePath: '.git',
      recursive: true
    })

    expectRefused(response)
    expect(existsSync(join(repoPath, '.git'))).toBe(true)
    expect(await readAdminState()).toEqual(before)
    expect(await readFile(join(repoPath, 'tracked.txt'), 'utf-8')).toBe('working tree content\n')
  })

  it.each([
    ['.git', true],
    ['.git/', true],
    ['.git/config', false],
    ['.git/worktrees/x', true],
    ['.GIT', true],
    ['.Git/config', false],
    ['.git\\config', false]
  ])('files.delete refuses %j', async (relativePath, recursive) => {
    const before = await readAdminState()

    const response = await dispatchFileMethod('files.delete', { relativePath, recursive })

    expect(response.ok).toBe(false)
    expect(await readAdminState()).toEqual(before)
  })

  it('files.rename refuses .git as the source', async () => {
    const response = await dispatchFileMethod('files.rename', {
      oldRelativePath: '.git',
      newRelativePath: 'git-backup'
    })

    expectRefused(response)
    expect(existsSync(join(repoPath, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(repoPath, 'git-backup'))).toBe(false)
  })

  // Why: the destination is the sharper half — a rename can substitute a `.git` a caller controls.
  it.each(['.git', '.git/hooks/pre-commit', '.GIT', '.git\\hooks\\pre-commit'])(
    'files.rename refuses %j as the destination',
    async (newRelativePath) => {
      const response = await dispatchFileMethod('files.rename', {
        oldRelativePath: 'tracked.txt',
        newRelativePath
      })

      expectRefused(response)
      expect(await readFile(join(repoPath, 'tracked.txt'), 'utf-8')).toBe('working tree content\n')
      expect(existsSync(join(repoPath, '.git', 'hooks'))).toBe(false)
    }
  )

  it.each(['.git/hooks/pre-commit', '.git/config', '.GIT/hooks/pre-commit'])(
    'files.copy refuses %j as the destination',
    async (destinationRelativePath) => {
      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'tracked.txt',
        destinationRelativePath
      })

      expectRefused(response)
      expect(existsSync(join(repoPath, '.git', 'hooks'))).toBe(false)
      expect(await readFile(join(repoPath, '.git', 'config'), 'utf-8')).toBe('[core]\n')
    }
  )

  it('files.copy refuses .git/config as the source', async () => {
    const response = await dispatchFileMethod('files.copy', {
      sourceRelativePath: '.git/config',
      destinationRelativePath: 'leaked-config'
    })

    expectRefused(response)
    expect(existsSync(join(repoPath, 'leaked-config'))).toBe(false)
  })

  it('files.commitUpload refuses .git as the final path', async () => {
    const response = await dispatchFileMethod('files.commitUpload', {
      tempRelativePath: 'tracked.txt',
      finalRelativePath: '.git/hooks/pre-commit'
    })

    expectRefused(response)
    expect(existsSync(join(repoPath, '.git', 'hooks'))).toBe(false)
  })

  it('files.commitUpload refuses .git as the temp path', async () => {
    const before = await readAdminState()

    const response = await dispatchFileMethod('files.commitUpload', {
      tempRelativePath: '.git/config',
      finalRelativePath: 'leaked-config'
    })

    expectRefused(response)
    expect(await readAdminState()).toEqual(before)
    expect(existsSync(join(repoPath, 'leaked-config'))).toBe(false)
  })

  it('files.write refuses to overwrite .git/config', async () => {
    const response = await dispatchFileMethod('files.write', {
      relativePath: '.git/config',
      content: '[core]\n\thooksPath = /tmp/evil\n'
    })

    expectRefused(response)
    expect(await readFile(join(repoPath, '.git', 'config'), 'utf-8')).toBe('[core]\n')
  })

  it.each([
    ['files.createFile', { relativePath: '.git/hooks/pre-commit' }],
    ['files.createDir', { relativePath: '.git/hooks' }],
    ['files.createDirNoClobber', { relativePath: '.git/hooks' }],
    ['files.writeBase64', { relativePath: '.git/config', contentBase64: 'ZXZpbA==' }],
    [
      'files.writeBase64Chunk',
      { relativePath: '.git/config', contentBase64: 'ZXZpbA==', append: true }
    ]
  ])('%s refuses a .git target', async (method, params) => {
    const before = await readAdminState()

    const response = await dispatchFileMethod(method, params)

    expectRefused(response)
    expect(await readAdminState()).toEqual(before)
    expect(existsSync(join(repoPath, '.git', 'hooks'))).toBe(false)
  })
})

describe('files.* RPCs still mutate ordinary git-adjacent names', () => {
  beforeEach(async () => {
    await buildRepo()
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it.each([
    ['.github/workflows/ci.yml', false],
    ['.github', true],
    ['.gitignore', false],
    ['.gitattributes', false],
    ['.gitmodules', false],
    ['src/.gitkeep', false],
    ['git', false],
    ['mygit', true],
    ['mygit/note.txt', false]
  ])('files.delete still removes %j', async (relativePath, recursive) => {
    const response = await dispatchFileMethod('files.delete', { relativePath, recursive })

    expect(response.ok).toBe(true)
    expect(existsSync(join(repoPath, ...relativePath.split('/')))).toBe(false)
  })

  it.each([
    ['.gitignore', 'ignore-backup'],
    ['.github', 'workflows-backup'],
    ['git', 'git-renamed'],
    ['mygit', 'mygit-renamed'],
    ['tracked.txt', '.gitignore.bak']
  ])('files.rename still moves %j to %j', async (oldRelativePath, newRelativePath) => {
    const response = await dispatchFileMethod('files.rename', {
      oldRelativePath,
      newRelativePath
    })

    expect(response.ok).toBe(true)
    expect(existsSync(join(repoPath, oldRelativePath))).toBe(false)
    expect(existsSync(join(repoPath, newRelativePath))).toBe(true)
  })

  it('files.copy still writes a .gitkeep destination', async () => {
    const response = await dispatchFileMethod('files.copy', {
      sourceRelativePath: 'tracked.txt',
      destinationRelativePath: 'mygit/.gitkeep'
    })

    expect(response.ok).toBe(true)
    expect(await readFile(join(repoPath, 'mygit', '.gitkeep'), 'utf-8')).toBe(
      'working tree content\n'
    )
  })

  it('files.createDir still creates .github/ISSUE_TEMPLATE', async () => {
    const response = await dispatchFileMethod('files.createDir', {
      relativePath: '.github/ISSUE_TEMPLATE'
    })

    expect(response.ok).toBe(true)
    expect(existsSync(join(repoPath, '.github', 'ISSUE_TEMPLATE'))).toBe(true)
  })
})

describe('files.* RPCs refuse a linked worktree .git pointer file', () => {
  beforeEach(async () => {
    await buildRepo(true)
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  // Why: Orca-managed linked worktrees carry `.git` as a gitdir pointer FILE, so a non-recursive
  // delete is enough to orphan the worktree.
  it('files.delete refuses the .git pointer file without recursion', async () => {
    const response = await dispatchFileMethod('files.delete', {
      relativePath: '.git',
      recursive: false
    })

    expectRefused(response)
    expect(await readFile(join(repoPath, '.git'), 'utf-8')).toBe(
      'gitdir: /elsewhere/.git/worktrees/feature\n'
    )
  })

  it('files.write refuses to repoint the .git pointer file', async () => {
    const response = await dispatchFileMethod('files.write', {
      relativePath: '.git',
      content: 'gitdir: /attacker/.git\n'
    })

    expectRefused(response)
    expect(await readFile(join(repoPath, '.git'), 'utf-8')).toBe(
      'gitdir: /elsewhere/.git/worktrees/feature\n'
    )
  })
})
