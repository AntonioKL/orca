import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  discard: vi.fn(),
  git: vi.fn(),
  arm: vi.fn(),
  recordPid: vi.fn(),
  release: vi.fn()
}))
vi.mock('./worktree-index-warming-ownership', () => ({
  WorktreeIndexWarmingOwnership: class {
    arm = mocks.arm
    recordPid = mocks.recordPid
    release = mocks.release
  },
  canReclaimIndexWarming: vi.fn().mockResolvedValue(true),
  removeIndexWarmingOwnership: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }))
vi.mock('./git/runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare
}))
vi.mock('./worktree-create-preparation-stale-cleanup', () => ({
  cleanupStalePreparations: vi.fn(),
  hasPendingStalePreparationCleanup: () => false,
  resetStalePreparationCleanupForTests: vi.fn()
}))
vi.mock('./worktree-preparation-discard-retry', () => ({
  discardPreparationWithRetry: mocks.discard,
  trackPreparationDiscard: vi.fn(),
  resetPendingPreparationDiscardsForTests: vi.fn()
}))
import {
  startPreparation,
  listPreparations,
  takePreparation,
  _resetPreparationPoolForTests,
  WORKTREE_CREATE_PREPARATION_TTL_MS
} from './worktree-create-preparation-pool'
const args = {
  repoPath: '/repo',
  workspaceRoot: '/workspaces',
  baseBranch: 'main',
  canonicalBase: 'refs/heads/main',
  options: {}
}
const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  vi.useFakeTimers()
  mocks.prepare.mockReset().mockResolvedValue(undefined)
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.git.mockReset().mockResolvedValue({ stdout: '' })
  mocks.arm.mockReset().mockResolvedValue(undefined)
  mocks.recordPid.mockReset()
  mocks.release.mockReset().mockResolvedValue(true)
})
afterEach(async () => {
  await _resetPreparationPoolForTests()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})
it('makes preparation ready before aging and runs at most one background refresh', async () => {
  await startPreparation(args)
  expect(mocks.prepare.mock.calls[0][3]).toContain('orca-create-preparation:v2:')
  expect(mocks.git).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(mocks.git).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  expect(mocks.git).toHaveBeenCalledExactlyOnceWith(
    ['update-index', '--refresh'],
    expect.objectContaining({
      cwd: listPreparations()[0].preparedPath,
      admissionTier: 'background',
      terminationBarrier: true,
      timeout: 15_000,
      signal: expect.any(AbortSignal)
    })
  )
  await vi.advanceTimersByTimeAsync(10_000)
  expect(mocks.git).toHaveBeenCalledOnce()
})
it('a claim before readiness prevents later optional work', async () => {
  let finish!: () => void
  mocks.prepare.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const ready = startPreparation(args)
  await vi.advanceTimersByTimeAsync(0)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(true)
  finish()
  await ready
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mocks.git).not.toHaveBeenCalled()
})
it('a quick claim cancels the aging timer without starting Git', async () => {
  await startPreparation(args)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(true)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mocks.git).not.toHaveBeenCalled()
})
it('a claim aborts active warming and waits for settlement', async () => {
  let finish!: () => void
  mocks.git.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  const stopped = takePreparation(listPreparations()[0])
  let settled = false
  void stopped.then(() => {
    settled = true
  })
  expect(mocks.git.mock.calls[0][1].signal.aborted).toBe(true)
  await Promise.resolve()
  expect(settled).toBe(false)
  finish()
  await expect(stopped).resolves.toBe(true)
})
it.each(['expiry', 'eviction', 'reset'])(
  '%s waits for active warming before discard',
  async (mode) => {
    let finish!: () => void
    mocks.git.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    await startPreparation(args)
    await vi.advanceTimersByTimeAsync(1_100)
    const path = listPreparations()[0].preparedPath
    let reset: Promise<void> | undefined
    if (mode === 'expiry') {
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
    } else if (mode === 'reset') {
      reset = _resetPreparationPoolForTests()
    } else {
      for (let i = 0; i < 3; i++) {
        await startPreparation({
          ...args,
          baseBranch: `branch${i}`,
          canonicalBase: `refs/heads/branch${i}`
        })
      }
    }
    await Promise.resolve()
    expect(mocks.git.mock.calls[0][1].signal.aborted).toBe(true)
    expect(mocks.discard).not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    await reset
    expect(mocks.discard).toHaveBeenCalledWith(expect.objectContaining({ preparedPath: path }))
  }
)
it('retains unverifiable preparations and disables further warming', async () => {
  mocks.git.mockRejectedValue({ terminationUnverifiable: true })
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(false)
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mocks.git).toHaveBeenCalledOnce()
  expect(mocks.discard).not.toHaveBeenCalled()
})
it('does not discard an expired preparation whose warming termination is unverifiable', async () => {
  mocks.git.mockRejectedValue({ terminationUnverifiable: true })
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
  expect(mocks.discard).not.toHaveBeenCalled()
})
it('keeps ordinary checkout fallback after optional refresh failure', async () => {
  mocks.git.mockRejectedValue(new Error('index refresh failed'))
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(true)
})
it.each(['linux', 'win32', 'wsl'])('does not warm %s preparations', async (platform) => {
  if (platform !== 'wsl') {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
  await startPreparation({ ...args, options: platform === 'wsl' ? { wslDistro: 'Ubuntu' } : {} })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mocks.git).not.toHaveBeenCalled()
})

it('cancels during ownership persistence without spawning Git', async () => {
  let finish!: () => void
  mocks.arm.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  const stopped = takePreparation(listPreparations()[0])
  expect(mocks.git).not.toHaveBeenCalled()
  finish()
  await expect(stopped).resolves.toBe(true)
  expect(mocks.git).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})
it('does not spawn Git if durable ownership cannot be established', async () => {
  mocks.arm.mockRejectedValue(new Error('permission denied'))
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(false)
  expect(mocks.git).not.toHaveBeenCalled()
})
it('persists the actual spawned PID and releases ownership after Git settles', async () => {
  mocks.git.mockImplementation(async (_args, options) => {
    options.onChildSpawned(12345)
  })
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  expect(mocks.recordPid).toHaveBeenCalledWith(12345)
  expect(mocks.release).toHaveBeenCalledOnce()
})
it('retains the checkout if the ownership marker cannot be removed', async () => {
  mocks.release.mockRejectedValue(new Error('busy'))
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(false)
})
it('successful Git exit with a live group blocks claim, retains ownership and disables warming', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.release.mockResolvedValue(false)
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  expect(mocks.release).toHaveBeenCalledOnce()
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(false)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('process group live or unverifiable'))
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mocks.git).toHaveBeenCalledOnce()
  expect(mocks.discard).not.toHaveBeenCalled()
})
it('does not discard an expired preparation whose group is live after Git success', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.release.mockResolvedValue(false)
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
  expect(mocks.discard).not.toHaveBeenCalled()
})
it('a refresh failure still requires the spawned group to have exited', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.git.mockImplementation(async (_args, options) => {
    options.onChildSpawned(12345)
    throw new Error('index refresh failed')
  })
  mocks.release.mockResolvedValue(false)
  await startPreparation(args)
  await vi.advanceTimersByTimeAsync(1_100)
  expect(mocks.recordPid).toHaveBeenCalledWith(12345)
  await expect(takePreparation(listPreparations()[0])).resolves.toBe(false)
})
