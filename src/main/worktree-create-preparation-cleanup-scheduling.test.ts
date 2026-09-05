import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  list: vi.fn(),
  prepare: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.list }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
}))

import {
  _resetPreparationPoolForTests,
  hasPendingPreparations,
  listPreparations,
  startPreparation,
  takePreparation
} from './worktree-create-preparation-pool'

const args = {
  repoPath: '/repo',
  workspaceRoot: '/workspace',
  baseBranch: 'origin/main',
  canonicalBase: 'refs/remotes/origin/main',
  options: {}
}

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.list.mockReset().mockResolvedValue([])
  mocks.prepare.mockReset().mockResolvedValue(undefined)
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => _resetPreparationPoolForTests())

describe('preparation cleanup scheduling', () => {
  it('finishes and claims a checkout while the stale scan is unresolved', async () => {
    const scan = Promise.withResolvers<never[]>()
    mocks.list.mockReturnValue(scan.promise)
    try {
      await startPreparation(args)
      const [entry] = listPreparations()
      await entry.ready
      takePreparation(entry)
      expect(mocks.prepare).toHaveBeenCalledOnce()
      expect(mocks.list).toHaveBeenCalledOnce()
      expect(hasPendingPreparations()).toBe(true)
    } finally {
      scan.resolve([])
    }
  })

  it('joins a running cleanup when another checkout finishes on the same host', async () => {
    const scan = Promise.withResolvers<never[]>()
    mocks.list.mockReturnValue(scan.promise)
    try {
      await Promise.all([
        startPreparation(args),
        startPreparation({ ...args, canonicalBase: 'refs/remotes/origin/release' })
      ])
      expect(mocks.prepare).toHaveBeenCalledTimes(2)
      expect(mocks.list).toHaveBeenCalledOnce()
    } finally {
      scan.resolve([])
    }
  })

  it('retains cleanup ownership after every prepared checkout is claimed', async () => {
    const scan = Promise.withResolvers<never[]>()
    mocks.list.mockReturnValue(scan.promise)
    await startPreparation(args)
    for (const entry of listPreparations()) {
      takePreparation(entry)
    }
    let resetFinished = false
    const reset = _resetPreparationPoolForTests().then(() => {
      resetFinished = true
    })
    try {
      await Promise.resolve()
      expect(resetFinished).toBe(false)
      expect(hasPendingPreparations()).toBe(true)
    } finally {
      scan.resolve([])
      await reset
    }
    expect(hasPendingPreparations()).toBe(false)
  })

  it('starts cleanup even when checkout fails', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('checkout failed'))
    await expect(startPreparation(args)).rejects.toThrow('checkout failed')
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('reclaims stale space before releasing a failed checkout to the ordinary-create fallback', async () => {
    const scan = Promise.withResolvers<never[]>()
    const failure = new Error('checkout: no space left on device')
    mocks.list.mockReturnValue(scan.promise)
    mocks.prepare.mockRejectedValueOnce(failure)
    let outcome: unknown = null
    const preparation = startPreparation(args).catch((error) => {
      outcome = error
    })
    try {
      await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
      expect(outcome).toBeNull()
    } finally {
      scan.resolve([])
      await preparation
    }
    expect(outcome).toBe(failure)
  })

  it('does not compete with the initial checkout for disk work', async () => {
    const checkout = Promise.withResolvers<void>()
    mocks.prepare.mockReturnValue(checkout.promise)
    const ready = startPreparation(args)
    try {
      await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
      expect(mocks.list).not.toHaveBeenCalled()
    } finally {
      checkout.resolve()
      await ready
    }
    expect(mocks.list).toHaveBeenCalledOnce()
  })
})
