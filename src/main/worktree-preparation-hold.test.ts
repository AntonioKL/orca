import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), discard: vi.fn() }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => {}) }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare
}))
vi.mock('./worktree-create-preparation-stale-cleanup', () => ({
  cleanupStalePreparations: vi.fn(async () => {}),
  hasPendingStalePreparationCleanup: () => false,
  resetStalePreparationCleanupForTests: vi.fn(async () => {})
}))
vi.mock('./worktree-preparation-discard-retry', () => ({
  discardPreparationWithRetry: mocks.discard,
  trackPreparationDiscard: vi.fn(),
  resetPendingPreparationDiscardsForTests: vi.fn(async () => {})
}))
import {
  startPreparation,
  listPreparations,
  holdPreparation,
  takePreparation,
  _resetPreparationPoolForTests,
  WORKTREE_CREATE_PREPARATION_TTL_MS as ttl,
  WORKTREE_CREATE_PREPARATION_LIMIT as limit
} from './worktree-create-preparation-pool'

const args = {
  repoPath: '/repo',
  workspaceRoot: '/workspace',
  baseBranch: 'main',
  canonicalBase: 'refs/heads/main',
  options: {}
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mocks.prepare.mockResolvedValue(undefined)
  mocks.discard.mockResolvedValue(undefined)
})
afterEach(async () => {
  await _resetPreparationPoolForTests()
  vi.useRealTimers()
})

it('keeps one checkout through repeated TTLs without rebuilding and expires after final release', async () => {
  await startPreparation(args)
  const entry = listPreparations()[0]
  const releaseFirst = holdPreparation(entry)
  const releaseSecond = holdPreparation(entry)
  await vi.advanceTimersByTimeAsync(ttl * 3)
  expect(listPreparations()).toEqual([entry])
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(mocks.discard).not.toHaveBeenCalled()
  releaseFirst()
  releaseFirst()
  await vi.advanceTimersByTimeAsync(ttl * 2)
  expect(listPreparations()).toEqual([entry])
  releaseSecond()
  await vi.advanceTimersByTimeAsync(ttl - 1)
  expect(mocks.discard).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(listPreparations()).toEqual([])
  expect(mocks.discard).toHaveBeenCalledOnce()
})

it('never deletes a held checkout after Create has claimed it', async () => {
  await startPreparation(args)
  const entry = listPreparations()[0]
  const release = holdPreparation(entry)
  takePreparation(entry)
  release()
  await vi.advanceTimersByTimeAsync(ttl * 2)
  expect(mocks.discard).not.toHaveBeenCalled()
})

it('preserves the pool limit even if every entry is held', async () => {
  const releases: (() => void)[] = []
  for (let i = 0; i <= limit; i++) {
    await startPreparation({ ...args, canonicalBase: `refs/heads/branch-${i}` })
    releases.push(holdPreparation(listPreparations().at(-1)!))
  }
  expect(listPreparations()).toHaveLength(limit)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.discard).toHaveBeenCalledOnce()
  releases.forEach((release) => release())
})
