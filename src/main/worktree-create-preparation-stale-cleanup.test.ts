import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn(),
  canReclaim: vi.fn(),
  remove: vi.fn(),
  disable: vi.fn()
}))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.list }))
vi.mock('./git/worktree-create-preparation', () => ({
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
}))
vi.mock('./worktree-index-warming-ownership', () => ({
  canReclaimIndexWarming: mocks.canReclaim,
  removeIndexWarmingOwnership: mocks.remove
}))
vi.mock('./worktree-prepared-index-warming', () => ({ disablePreparedIndexWarming: mocks.disable }))
vi.mock('./worktree-preparation-discard-retry', () => ({
  retryPendingPreparationDiscards: vi.fn()
}))
import {
  cleanupStalePreparations,
  resetStalePreparationCleanupForTests
} from './worktree-create-preparation-stale-cleanup'
const path = '/workspaces/.orca-preparing/12345-c0b782fc-0eb4-4196-8226-3cc9268963dd'
beforeEach(() => {
  mocks.list
    .mockReset()
    .mockResolvedValue([{ path, lockReason: 'orca-create-preparation:v2:12345:session' }])
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset()
  mocks.canReclaim.mockReset().mockResolvedValue(false)
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.disable.mockReset()
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  resetStalePreparationCleanupForTests()
})
it('retains warming after owner exit when the worker group is not proven exited', async () => {
  await cleanupStalePreparations('repo', '/repo', {})
  expect(mocks.canReclaim).toHaveBeenCalledWith(path, undefined)
  expect(mocks.discard).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
  expect(mocks.disable).toHaveBeenCalledOnce()
})
it('reclaims proven-exited warming and removes the record after checkout removal', async () => {
  mocks.canReclaim.mockResolvedValue(true)
  await cleanupStalePreparations('repo', '/repo', {})
  expect(mocks.discard).toHaveBeenCalledWith('/repo', path, {})
  expect(mocks.remove).toHaveBeenCalledWith(path)
  expect(mocks.discard.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.remove.mock.invocationCallOrder[0]
  )
})
it('keeps the record when worktree removal fails', async () => {
  mocks.canReclaim.mockResolvedValue(true)
  mocks.discard.mockRejectedValue(new Error('busy'))
  await cleanupStalePreparations('repo', '/repo', {})
  expect(mocks.remove).not.toHaveBeenCalled()
})
it('keeps live-owner preparations without probing the worker', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true)
  await cleanupStalePreparations('repo', '/repo', {})
  expect(mocks.canReclaim).not.toHaveBeenCalled()
  expect(mocks.discard).not.toHaveBeenCalled()
})
it('preserves legacy cleanup without optional-worker probes', async () => {
  mocks.list.mockResolvedValue([{ path, lockReason: 'orca-create-preparation:v1:12345:session' }])
  await cleanupStalePreparations('repo', '/repo', {})
  expect(mocks.discard).toHaveBeenCalledOnce()
  expect(mocks.canReclaim).not.toHaveBeenCalled()
})
