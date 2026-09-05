import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  standby: vi.fn(),
  retain: vi.fn(),
  prefetch: vi.fn(),
  getRepo: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../worktree-create-standby', () => ({
  prepareWorktreeCreateStandby: mocks.standby,
  retainWorktreeCreateStandby: mocks.retain
}))
vi.mock('../../../worktree-create-base-prefetch', () => ({
  prefetchWorktreeCreateBase: mocks.prefetch
}))
vi.mock('../../../worktree-create-preparation', () => ({ prepareWorktreeCreateForRepo: vi.fn() }))
vi.mock('../../../project-runtime-git-options', () => ({
  getWorktreeCreatePrefetchGitOptions: vi.fn()
}))

import { registerWorktreePrefetchHandler } from './register-worktree-prefetch-handler'

const context = { store: { getRepo: mocks.getRepo }, runtime: {} } as unknown as WorktreeIpcContext
const repo = { id: 'repo', path: '/repo' }
let standby: (event: null, args: { repoId: string; baseBranch?: string }) => Promise<void>
let dispose: () => void
beforeEach(() => {
  vi.resetAllMocks()
  mocks.getRepo.mockReturnValue(repo)
  dispose = registerWorktreePrefetchHandler(context)
  standby = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'worktrees:prepareCreateCheckout'
  )![1]
})

it('uses checkout-only preparation without invoking the fetch flow', async () => {
  await standby(null, { repoId: 'repo', baseBranch: 'chosen' })
  expect(mocks.standby).toHaveBeenCalledExactlyOnceWith(context.store, repo, 'chosen')
  expect(mocks.prefetch).not.toHaveBeenCalled()
})

it('ignores a repository removed before the request arrives', async () => {
  mocks.getRepo.mockReturnValue(undefined)
  await standby(null, { repoId: 'repo' })
  expect(mocks.standby).not.toHaveBeenCalled()
})

it('contains speculative failure without falling back to a fetch', async () => {
  mocks.standby.mockRejectedValue(new Error('disk full'))
  await expect(standby(null, { repoId: 'repo' })).resolves.toBeUndefined()
  expect(mocks.prefetch).not.toHaveBeenCalled()
})

afterEach(() => dispose())

it.each(['destroy', 'crash', 'reload', 'register cleanup'] as const)(
  'releases held checkout on %s',
  async (action) => {
    const release = vi.fn()
    mocks.retain.mockResolvedValue(release)
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const handler = mocks.handle.mock.calls.find(
      ([name]) => name === 'worktrees:setCreateStandby'
    )![1]
    await handler({ sender }, { repoId: 'repo', baseBranch: 'chosen' })
    expect(mocks.retain).toHaveBeenCalledExactlyOnceWith(
      context.store,
      repo,
      'chosen',
      expect.any(Function)
    )
    if (action === 'destroy') {
      sender.emit('destroyed')
    } else {
      dispose()
    }
    expect(release).toHaveBeenCalledOnce()
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  }
)

it('releases on hide without starting another preparation', async () => {
  const release = vi.fn()
  mocks.retain.mockResolvedValue(release)
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'worktrees:setCreateStandby'
  )![1]
  await handler({ sender }, { repoId: 'repo' })
  await handler({ sender }, { repoId: null })
  expect(release).toHaveBeenCalledOnce()
  expect(mocks.retain).toHaveBeenCalledOnce()
})
