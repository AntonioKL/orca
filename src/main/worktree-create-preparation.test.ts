import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepareCheckout: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  getWorktreeOptions: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepareCheckout,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions
}))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRoot: () => '/workspace',
  getWorktreePathSettings: () => ({ workspaceDir: '/workspace', nestWorkspaces: false })
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

const repo = { id: 'repo-1', path: '/repo' } as Repo
const store = { getSettings: () => ({}) } as unknown as Store

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepareCheckout.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})

describe('worktree create preparation registry', () => {
  it('deduplicates preparation for the same repo, base, runtime, and workspace root', async () => {
    await Promise.all([
      prepareWorktreeCreateForRepo(store, repo, 'origin/main'),
      prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    ])

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not claim a preparation after the selected base changes', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/release'
      })
    ).resolves.toBeNull()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('routes preparation and finalization through the selected WSL runtime', async () => {
    const options = { wslDistro: 'Ubuntu' }
    mocks.getWorktreeOptions.mockReturnValue(options)
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/final',
      branch: 'feature/test',
      baseBranch: 'origin/main',
      options
    })

    expect(mocks.prepareCheckout).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      'origin/main',
      expect.any(String),
      options
    )
    expect(mocks.finalize).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      '/workspace/final',
      'feature/test',
      'origin/main',
      undefined,
      options
    )
  })

  it('retries stale cleanup after a transient listing failure', async () => {
    mocks.listWorktreeGraph.mockRejectedValueOnce(new Error('temporary listing failure'))
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/release')

    expect(mocks.listWorktreeGraph).toHaveBeenCalledTimes(2)
  })

  it('cleans up and returns null so normal add can run when finalization fails', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.finalize.mockRejectedValueOnce(new Error('submodules prevent worktree move'))

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toBeNull()
    expect(mocks.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true })
    expect(mocks.discard).toHaveBeenCalledTimes(1)
  })
})
