import { expect, it, vi } from 'vitest'
import { createWorktreeStandbyOwner } from './worktree-create-standby-owner'

function deferred() {
  let resolve!: (release: () => void) => void
  const promise = new Promise<() => void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('serializes disk work and skips targets replaced while queued', async () => {
  const first = createWorktreeStandbyOwner()
  const second = createWorktreeStandbyOwner()
  const pending = deferred()
  const releaseFirst = vi.fn()
  const releaseLast = vi.fn()
  const start = vi.fn(() => pending.promise)
  const skipped = vi.fn(async () => () => {})
  const last = vi.fn(async () => releaseLast)
  const active = first.set(start)
  await Promise.resolve()
  expect(start).toHaveBeenCalledOnce()
  const obsolete = second.set(skipped)
  const latest = second.set(last)
  await Promise.resolve()
  expect(last).not.toHaveBeenCalled()
  pending.resolve(releaseFirst)
  await Promise.all([active, obsolete, latest])
  expect(skipped).not.toHaveBeenCalled()
  expect(last).toHaveBeenCalledOnce()
  first.close()
  second.close()
  expect(releaseFirst).toHaveBeenCalledOnce()
  expect(releaseLast).toHaveBeenCalledOnce()
})

it('releases a preparation that finishes after its owner is closed', async () => {
  const owner = createWorktreeStandbyOwner()
  const pending = deferred()
  const release = vi.fn()
  const work = owner.set(() => pending.promise)
  await Promise.resolve()
  owner.close()
  pending.resolve(release)
  await work
  expect(release).toHaveBeenCalledOnce()
  const prepare = vi.fn()
  await owner.set(prepare)
  expect(prepare).not.toHaveBeenCalled()
})

it('releases on hide and does not poison later work after a failed preparation', async () => {
  const owner = createWorktreeStandbyOwner()
  await owner.set(async () => {
    throw new Error('disk unavailable')
  })
  const release = vi.fn()
  await owner.set(async () => release)
  await owner.set()
  owner.close()
  expect(release).toHaveBeenCalledOnce()
})
