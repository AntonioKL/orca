import { describe, expect, it, vi } from 'vitest'
import {
  WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR,
  WorktreeTerminalMutationLock
} from './worktree-terminal-mutation-lock'

const KEY = 'repo::/tmp/worktree'

describe('WorktreeTerminalMutationLock', () => {
  it('grants concurrent spawns without serializing them', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releases = await Promise.all([
      lock.acquire(KEY, 'spawn'),
      lock.acquire(KEY, 'spawn'),
      lock.acquire(KEY, 'spawn'),
      lock.acquire(KEY, 'spawn')
    ])
    expect(releases).toHaveLength(4)
    for (const release of releases) {
      release()
    }
    expect(lock.trackedKeyCount).toBe(0)
  })

  it('isolates keys so one worktree never blocks another', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releaseSleep = await lock.acquire(KEY, 'sleep')
    const releaseOther = await lock.acquire('other', 'spawn')
    expect(releaseOther).toBeTypeOf('function')
    releaseSleep()
    releaseOther()
    expect(lock.trackedKeyCount).toBe(0)
  })

  it('makes sleep wait for in-flight spawns', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releaseSpawnA = await lock.acquire(KEY, 'spawn')
    const releaseSpawnB = await lock.acquire(KEY, 'spawn')

    let sleepAcquired = false
    const sleep = lock.acquire(KEY, 'sleep').then((release) => {
      sleepAcquired = true
      return release
    })
    await Promise.resolve()
    expect(sleepAcquired).toBe(false)

    releaseSpawnA()
    await Promise.resolve()
    expect(sleepAcquired).toBe(false)

    releaseSpawnB()
    const releaseSleep = await sleep
    expect(sleepAcquired).toBe(true)
    releaseSleep()
    expect(lock.trackedKeyCount).toBe(0)
  })

  it('makes a spawn wait for an in-flight sleep', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releaseSleep = await lock.acquire(KEY, 'sleep')

    let spawnAcquired = false
    const spawn = lock.acquire(KEY, 'spawn').then((release) => {
      spawnAcquired = true
      return release
    })
    await Promise.resolve()
    expect(spawnAcquired).toBe(false)

    releaseSleep()
    const releaseSpawn = await spawn
    expect(spawnAcquired).toBe(true)
    releaseSpawn()
  })

  it('prefers a waiting sleep over later spawns so sleep cannot starve', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releaseFirstSpawn = await lock.acquire(KEY, 'spawn')

    const order: string[] = []
    const sleep = lock.acquire(KEY, 'sleep').then((release) => {
      order.push('sleep')
      return release
    })
    // Queued after the sleep, so it must not jump ahead even though spawns share.
    const laterSpawn = lock.acquire(KEY, 'spawn').then((release) => {
      order.push('spawn')
      return release
    })

    await Promise.resolve()
    expect(order).toEqual([])

    releaseFirstSpawn()
    const releaseSleep = await sleep
    expect(order).toEqual(['sleep'])
    releaseSleep()
    const releaseLaterSpawn = await laterSpawn
    expect(order).toEqual(['sleep', 'spawn'])
    releaseLaterSpawn()
    expect(lock.trackedKeyCount).toBe(0)
  })

  it('expires a queued sleep at its deadline and never grants it later', async () => {
    vi.useFakeTimers()
    try {
      const lock = new WorktreeTerminalMutationLock()
      const releaseSpawn = await lock.acquire(KEY, 'spawn')
      const sleep = lock.acquire(KEY, 'sleep', Date.now() + 1_000)
      const rejection = expect(sleep).rejects.toThrow(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)
      await vi.advanceTimersByTimeAsync(1_001)
      await rejection

      // The abandoned node must not hold the lock: a later spawn acquires freely.
      releaseSpawn()
      const releaseNext = await lock.acquire(KEY, 'spawn')
      releaseNext()
      expect(lock.trackedKeyCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately when the deadline has already passed', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releaseSpawn = await lock.acquire(KEY, 'spawn')
    await expect(lock.acquire(KEY, 'sleep', Date.now() - 1)).rejects.toThrow(
      WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR
    )
    releaseSpawn()
  })

  it('hands the turn onward when a queued sleep abandons ahead of a spawn', async () => {
    vi.useFakeTimers()
    try {
      const lock = new WorktreeTerminalMutationLock()
      const releaseSpawn = await lock.acquire(KEY, 'spawn')
      const sleep = lock.acquire(KEY, 'sleep', Date.now() + 1_000)
      const rejection = expect(sleep).rejects.toThrow(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)
      let laterSpawnAcquired = false
      const laterSpawn = lock.acquire(KEY, 'spawn').then((release) => {
        laterSpawnAcquired = true
        return release
      })

      await vi.advanceTimersByTimeAsync(1_001)
      await rejection
      // The spawn was queued behind the sleep; its abandonment must release it.
      const releaseLater = await laterSpawn
      expect(laterSpawnAcquired).toBe(true)
      releaseSpawn()
      releaseLater()
      expect(lock.trackedKeyCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores repeated release calls', async () => {
    const lock = new WorktreeTerminalMutationLock()
    const releaseSpawn = await lock.acquire(KEY, 'spawn')
    const releaseOther = await lock.acquire(KEY, 'spawn')
    releaseSpawn()
    releaseSpawn()
    releaseSpawn()

    // The double release must not have dropped the sibling spawn's hold.
    let sleepAcquired = false
    const sleep = lock.acquire(KEY, 'sleep').then((release) => {
      sleepAcquired = true
      return release
    })
    await Promise.resolve()
    expect(sleepAcquired).toBe(false)
    releaseOther()
    ;(await sleep)()
    expect(lock.trackedKeyCount).toBe(0)
  })
})
