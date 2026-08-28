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
  schedule: (targetId: string, placement: DirectSshSnapshotPlacement, attempt: number) => void
  stop: () => void
}

export function createUnplacedSnapshotRepull(
  deps: UnplacedSnapshotRepullDeps
): UnplacedSnapshotRepull {
  const timerByTarget = new Map<string, ReturnType<typeof setTimeout>>()

  const clearTimer = (targetId: string): void => {
    const timer = timerByTarget.get(targetId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timerByTarget.delete(targetId)
    }
  }

  const schedule = (
    targetId: string,
    placement: DirectSshSnapshotPlacement,
    attempt: number
  ): void => {
    if (placement !== 'unplaced' || deps.isStopped()) {
      // A `placed` or superseded apply retires the chain; a timer left armed would re-pull over a
      // target that has since hydrated correctly.
      clearTimer(targetId)
      return
    }
    const delayMs = UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[attempt]
    if (delayMs === undefined) {
      // Chain exhausted: report it rather than leaving the status stuck on `pulling` forever.
      clearTimer(targetId)
      deps.reportExhausted(targetId)
      return
    }
    clearTimer(targetId)
    timerByTarget.set(
      targetId,
      setTimeout(() => {
        timerByTarget.delete(targetId)
        void (async () => {
          if (deps.isStopped() || !deps.hasCurrentAuthority(targetId)) {
            return
          }
          const snapshot = await deps.getSnapshot(targetId)
          if (deps.isStopped() || !snapshot || snapshot.revision <= 0) {
            return
          }
          schedule(targetId, await deps.applySnapshot(targetId, snapshot), attempt + 1)
        })().catch(() => {})
      }, delayMs)
    )
  }

  return {
    schedule,
    stop: () => {
      for (const timer of timerByTarget.values()) {
        clearTimeout(timer)
      }
      timerByTarget.clear()
    }
  }
}
