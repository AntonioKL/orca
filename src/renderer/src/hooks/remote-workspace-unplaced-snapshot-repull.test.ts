/**
 * The re-pull chain that follows an `unplaced` snapshot apply (STA-3593). It exists because an
 * unplaceable tab row is `unverifiable` — the local catalog has not landed — so the client retries
 * the missing input rather than accepting the empty picture.
 *
 * Everything here is about the chain STOPPING: a retry loop that outlives its cause is worse than
 * the bug it fixes, because each attempt re-runs the host catalog and lineage reads against a host
 * that may be down. The oracles are boundedness, retirement on success, and silence after `stop()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshSnapshotPlacement } from './remote-workspace-snapshot-apply'
import {
  createUnplacedSnapshotRepull,
  UNPLACED_SNAPSHOT_REPULL_DELAYS_MS
} from './remote-workspace-unplaced-snapshot-repull'

const TARGET = 'target-a'
const OTHER_TARGET = 'target-b'
const LONG_AFTER_MS = 600_000

function snapshot(revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: {},
      terminalLayoutsByTabId: {}
    }
  }
}

type HarnessOptions = {
  /** Placement returned by the nth (0-based) re-pull apply. Defaults to `'unplaced'` forever. */
  placementByCall?: (call: number) => DirectSshSnapshotPlacement
  getSnapshot?: (targetId: string) => Promise<RemoteWorkspaceSnapshot | null>
}

function createHarness(options: HarnessOptions = {}) {
  let stopped = false
  const targetsWithAuthority = new Set([TARGET, OTHER_TARGET])
  const appliedTargets: string[] = []
  const exhaustedTargets: string[] = []

  const getSnapshot = vi.fn(options.getSnapshot ?? (async () => snapshot()))
  const applySnapshot = vi.fn(async (targetId: string): Promise<DirectSshSnapshotPlacement> => {
    const call = appliedTargets.length
    appliedTargets.push(targetId)
    return options.placementByCall?.(call) ?? 'unplaced'
  })

  const repull = createUnplacedSnapshotRepull({
    isStopped: () => stopped,
    hasCurrentAuthority: (targetId) => targetsWithAuthority.has(targetId),
    getSnapshot,
    applySnapshot,
    reportExhausted: (targetId) => exhaustedTargets.push(targetId)
  })

  return {
    repull,
    getSnapshot,
    applySnapshot,
    appliedTargets,
    exhaustedTargets,
    stop: () => {
      stopped = true
    },
    dropAuthority: (targetId: string) => targetsWithAuthority.delete(targetId)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the re-pull chain after an unplaced snapshot', () => {
  it('keeps the documented backoff so a retry cannot become a busy loop', () => {
    expect(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS).toEqual([1_000, 3_000, 8_000])
  })

  it('runs exactly one attempt per configured delay, then exhausts and stops for good', async () => {
    const harness = createHarness()
    harness.repull.schedule(TARGET, 'unplaced', 0)

    let elapsed = 0
    for (const [index, delayMs] of UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delayMs - 1)
      expect(
        harness.applySnapshot,
        `attempt ${index} fired before its ${delayMs}ms delay`
      ).toHaveBeenCalledTimes(index)
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.applySnapshot).toHaveBeenCalledTimes(index + 1)
      elapsed += delayMs
    }

    // Every attempt came back `unplaced`, so the chain has nothing left to try.
    expect(harness.exhaustedTargets).toEqual([TARGET])
    expect(elapsed).toBe(12_000)

    // The oracle: no fourth attempt, ever. Not a slower one, not a later one.
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)
    expect(harness.applySnapshot).toHaveBeenCalledTimes(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.length)
    expect(harness.getSnapshot).toHaveBeenCalledTimes(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.length)
    expect(harness.exhaustedTargets, 'exhaustion reported once, not once per idle tick').toEqual([
      TARGET
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires the chain as soon as a retry places the rows', async () => {
    const harness = createHarness({ placementByCall: () => 'placed' })
    harness.repull.schedule(TARGET, 'unplaced', 0)

    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0])
    expect(harness.appliedTargets).toEqual([TARGET])

    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)
    expect(
      harness.applySnapshot,
      'a re-pull over a target that has since hydrated would undo the successful placement'
    ).toHaveBeenCalledTimes(1)
    expect(harness.exhaustedTargets).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['placed', 'not-applied'] as const)(
    'cancels a pending attempt when a newer arrival reports %s',
    async (placement) => {
      const harness = createHarness()
      harness.repull.schedule(TARGET, 'unplaced', 0)
      await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0] - 100)

      // A snapshot that arrived on its own beat the pending retry to the answer.
      harness.repull.schedule(TARGET, placement, 0)

      await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)
      expect(harness.applySnapshot, 'the superseded attempt still fired').not.toHaveBeenCalled()
      expect(harness.exhaustedTargets).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('restarts a newer unplaced arrival from the first delay without arming two timers', async () => {
    const harness = createHarness({ placementByCall: () => 'placed' })
    harness.repull.schedule(TARGET, 'unplaced', 0)
    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0] - 100)

    harness.repull.schedule(TARGET, 'unplaced', 0)
    expect(vi.getTimerCount(), 'the replaced attempt left its timer armed').toBe(1)

    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0] - 1)
    expect(harness.applySnapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(
      harness.applySnapshot,
      'both the original and the replacement timer fired'
    ).toHaveBeenCalledTimes(1)
  })

  it('fires nothing after stop() clears an armed attempt', async () => {
    const harness = createHarness()
    harness.repull.schedule(TARGET, 'unplaced', 0)
    expect(vi.getTimerCount()).toBe(1)

    harness.repull.stop()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)
    expect(harness.getSnapshot).not.toHaveBeenCalled()
    expect(harness.applySnapshot).not.toHaveBeenCalled()
    expect(harness.exhaustedTargets).toEqual([])
  })

  it('does not apply or reschedule when stop() lands mid-flight', async () => {
    let releaseSnapshot: (value: RemoteWorkspaceSnapshot | null) => void = () => {}
    const pending = new Promise<RemoteWorkspaceSnapshot | null>((resolve) => {
      releaseSnapshot = resolve
    })
    const harness = createHarness({ getSnapshot: () => pending })
    harness.repull.schedule(TARGET, 'unplaced', 0)

    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0])
    expect(harness.getSnapshot).toHaveBeenCalledOnce()

    // The hook tore down while the host read was outstanding; its answer arrives afterwards.
    harness.stop()
    harness.repull.stop()
    releaseSnapshot(snapshot())
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)

    expect(harness.applySnapshot, 'a torn-down sync applied a late snapshot').not.toHaveBeenCalled()
    expect(harness.exhaustedTargets).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses to schedule at all once stopped', async () => {
    const harness = createHarness()
    harness.stop()

    harness.repull.schedule(TARGET, 'unplaced', 0)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)
    expect(harness.applySnapshot).not.toHaveBeenCalled()
  })

  it('abandons the chain when the target lost its authority before the retry fired', async () => {
    const harness = createHarness()
    harness.repull.schedule(TARGET, 'unplaced', 0)

    harness.dropAuthority(TARGET)
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)

    expect(harness.applySnapshot).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['no snapshot', null],
    ['a revision-zero snapshot', snapshot(0)]
  ])('stops rather than retrying when the host returns %s', async (_label, response) => {
    const harness = createHarness({ getSnapshot: async () => response })
    harness.repull.schedule(TARGET, 'unplaced', 0)

    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)

    expect(
      harness.getSnapshot,
      'the chain retried past an unusable host response'
    ).toHaveBeenCalledOnce()
    expect(harness.applySnapshot).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs one independent chain per target', async () => {
    const harness = createHarness({
      // target-a keeps failing to place; target-b succeeds on its first retry.
      placementByCall: (call) => (call === 0 ? 'placed' : 'unplaced')
    })
    harness.repull.schedule(OTHER_TARGET, 'unplaced', 0)
    harness.repull.schedule(TARGET, 'unplaced', 0)
    expect(vi.getTimerCount(), 'targets share a timer slot').toBe(2)

    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0])
    expect(harness.appliedTargets).toEqual([OTHER_TARGET, TARGET])

    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS)
    // target-b retired after one attempt; target-a burned its full chain.
    expect(harness.appliedTargets.filter((id) => id === OTHER_TARGET)).toHaveLength(1)
    expect(harness.appliedTargets.filter((id) => id === TARGET)).toHaveLength(
      UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.length
    )
    expect(harness.exhaustedTargets).toEqual([TARGET])
  })
})
