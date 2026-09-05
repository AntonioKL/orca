import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'

const mocks = vi.hoisted(() => ({
  defaultBase: vi.fn(),
  hasBase: vi.fn(),
  options: vi.fn(),
  prepare: vi.fn()
}))
vi.mock('./git/repo', () => ({ getBaseRefDefault: mocks.defaultBase }))
vi.mock('./git/worktree-base-ref-probe', () => ({ hasLocalWorktreeBaseRef: mocks.hasBase }))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.options
}))
vi.mock('./worktree-create-preparation', () => ({ prepareWorktreeCreateForRepo: mocks.prepare }))

import { prepareWorktreeCreateStandby } from './worktree-create-standby'

const repo = { id: 'repo', path: '/repo' } as Repo
const store = {} as Store
beforeEach(() => {
  vi.resetAllMocks()
  mocks.options.mockReturnValue({})
  mocks.defaultBase.mockResolvedValue('origin/main')
  mocks.hasBase.mockResolvedValue(true)
  mocks.prepare.mockResolvedValue(undefined)
})

describe('checkout-only standby', () => {
  it.each([
    { ...repo, kind: 'folder' as const },
    { ...repo, connectionId: 'ssh' },
    { ...repo, executionHostId: 'runtime:other' as const }
  ])('does no local work for an ineligible repo', async (target) => {
    await prepareWorktreeCreateStandby(store, target)
    expect(mocks.options).not.toHaveBeenCalled()
    expect(mocks.defaultBase).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('prepares the detected default through the existing pool', async () => {
    await prepareWorktreeCreateStandby(store, repo)
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(store, repo, 'origin/main')
  })

  it('preserves an explicit composer base and does not resolve another default', async () => {
    await prepareWorktreeCreateStandby(store, repo, 'chosen')
    expect(mocks.defaultBase).not.toHaveBeenCalled()
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(store, repo, 'chosen')
  })

  it('preserves a usable repository override', async () => {
    const target = { ...repo, worktreeBaseRef: 'custom' }
    await prepareWorktreeCreateStandby(store, target)
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(store, target, 'custom')
  })

  it('falls back from a stale repository override', async () => {
    mocks.hasBase.mockImplementation(async (_path, base) => base !== 'stale')
    const target = { ...repo, worktreeBaseRef: 'stale' }
    await prepareWorktreeCreateStandby(store, target)
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(store, target, 'origin/main')
  })

  it.each([null, 'missing'])('does not prepare an unavailable base %s', async (base) => {
    mocks.defaultBase.mockResolvedValue(base)
    mocks.hasBase.mockResolvedValue(false)
    await prepareWorktreeCreateStandby(store, repo)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('routes every probe to the project WSL distro', async () => {
    mocks.options.mockReturnValue({ wslDistro: 'Ubuntu' })
    await prepareWorktreeCreateStandby(store, repo)
    expect(mocks.defaultBase).toHaveBeenCalledExactlyOnceWith('/repo', { wslDistro: 'Ubuntu' })
    expect(mocks.hasBase).toHaveBeenCalledExactlyOnceWith('/repo', 'origin/main', {
      wslDistro: 'Ubuntu'
    })
  })

  it('does not fall back to host Git when project runtime needs repair', async () => {
    mocks.options.mockImplementation(() => {
      throw new Error('repair-required')
    })
    await expect(prepareWorktreeCreateStandby(store, repo)).rejects.toThrow('repair-required')
    expect(mocks.defaultBase).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
