import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshSnapshotPlacement } from './remote-workspace-snapshot-apply'

/**
 * Backoff for re-pulling after a snapshot whose terminal-tab rows this client could not place.
 * Each attempt re-runs the host catalog + lineage reads, so it retries the *missing input* — a
 * degraded `listLineage` that left `worktreesByRepo` empty — not merely the pull. Bounded: past
 * this the target stays un-hydrated, which the seeding gate already reads as `unverifiable`.
 */
export const UNPLACED_SNAPSHOT_REPULL_DELAYS_MS = [1_000, 3_000, 8_000]

export type UnplacedSnapshotRepullDeps = {
  isStopped: () => boolean
  hasCurrentAuthority: (targetId: string) => boolean
  getSnapshot: (targetId: string) => Promise<RemoteWorkspaceSnapshot | null>
  applySnapshot: (
    targetId: string,
    snapshot: RemoteWorkspaceSnapshot
  ) => Promise<DirectSshSnapshotPlacement>
  reportExhausted: (targetId: string) => void
}

export type UnplacedSnapshotRepull = {
  /** Call with every apply outcome; anything but `unplaced` retires the target's pending chain. */
  schedule: (targetId: string, placement: DirectSshSnapshotPlacement) => void
  /**
   * Drop a target's spent attempt count so a new connection gets a fresh chain. Without this an
   * exhausted counter sticks, and every later reconnect re-exhausts immediately — the retry would
   * silently stop working for the rest of the session even when the next lineage read would succeed.
   */
  resetTarget: (targetId: string) => void
  stop: () => void
}

export function createUnplacedSnapshotRepull(
  deps: UnplacedSnapshotRepullDeps
): UnplacedSnapshotRepull {
  const timerByTarget = new Map<string, ReturnType<typeof setTimeout>>()
  // Why the module owns this and callers cannot pass it: an unsolicited `workspace.changed` push
  // also reports a placement, and letting it re-arm at attempt 0 means a host that pushes faster
  // than the backoff resets the chain forever — an unbounded loop re-dialling `workspace.get` that
  // never reaches exhaustion. Only a placement that is not `unplaced` clears the count.
  const attemptByTarget = new Map<string, number>()
  // Why a separate set and not just the spent count: after exhaustion every further `unplaced`
  // report still lands here, and re-announcing it would re-mark the target hydrated and rewrite
  // its status on every host push. Exhaustion is announced once per chain.
  const exhaustedTargets = new Set<string>()

  const clearTimer = (targetId: string): void => {
    const timer = timerByTarget.get(targetId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timerByTarget.delete(targetId)
    }
  }

  const schedule = (targetId: string, placement: DirectSshSnapshotPlacement): void => {
    if (placement !== 'unplaced' || deps.isStopped()) {
      // A `placed` or superseded apply retires the chain; a timer left armed would re-pull over a
      // target that has since hydrated correctly.
      clearTimer(targetId)
      attemptByTarget.delete(targetId)
      exhaustedTargets.delete(targetId)
      return
    }
    // Why this precedes the exhaustion check: once the last attempt is armed the count is already
    // spent, so testing exhaustion first would let a concurrent report cancel that still-pending
    // retry and declare the chain over one attempt early.
    if (timerByTarget.has(targetId)) {
      return
    }
    const attempt = attemptByTarget.get(targetId) ?? 0
    const delayMs = UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[attempt]
    if (delayMs === undefined) {
      if (!exhaustedTargets.has(targetId)) {
        exhaustedTargets.add(targetId)
        deps.reportExhausted(targetId)
      }
      return
    }
    attemptByTarget.set(targetId, attempt + 1)
    timerByTarget.set(
      targetId,
      setTimeout(() => {
        timerByTarget.delete(targetId)
        void (async () => {
          if (deps.isStopped()) {
            return
          }
          if (!deps.hasCurrentAuthority(targetId)) {
            // The target went away; a later connect calls `resetTarget` and starts over.
            attemptByTarget.delete(targetId)
            exhaustedTargets.delete(targetId)
            return
          }
          let outcome: DirectSshSnapshotPlacement = 'unplaced'
          try {
            const snapshot = await deps.getSnapshot(targetId)
            if (deps.isStopped()) {
              return
            }
            if (snapshot && snapshot.revision > 0) {
              outcome = await deps.applySnapshot(targetId, snapshot)
            }
          } catch {
            // Why the chain continues rather than dying here: a transient RPC failure that left no
            // timer armed would strand the target on `pulling` and un-hydrated forever — and an
            // un-hydrated target never uploads again. Staying `unplaced` walks the chain to
            // exhaustion, which settles it.
          }
          schedule(targetId, outcome)
        })().catch(() => {})
      }, delayMs)
    )
  }

  return {
    schedule,
    resetTarget: (targetId: string) => {
      clearTimer(targetId)
      attemptByTarget.delete(targetId)
      exhaustedTargets.delete(targetId)
    },
    stop: () => {
      for (const timer of timerByTarget.values()) {
        clearTimeout(timer)
      }
      timerByTarget.clear()
      attemptByTarget.clear()
      exhaustedTargets.clear()
    }
  }
}
