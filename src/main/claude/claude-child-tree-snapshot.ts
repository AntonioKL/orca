import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'

/** One platform's descendant tree, tagged so neither verifier can be handed the other's rows. */
export type ClaudeCapturedTree =
  | { platform: 'posix'; tree: DescendantSnapshot }
  | { platform: 'win32'; tree: WindowsDescendantSnapshot }

/**
 * Process-table reads are not atomic: a refresh can omit a still-live row, but
 * it can also observe a new process after the old row exited. Retain rows absent
 * from the refresh, but reject a PID whose identity changed between reads.
 */
function mergeRowsByPid<Row extends { pid: number }>(
  previous: readonly Row[],
  next: readonly Row[],
  sameIdentity: (previous: Row, next: Row) => boolean
): Row[] | null {
  const merged = new Map<number, Row>()
  for (const row of previous) {
    const prior = merged.get(row.pid)
    if (prior && !sameIdentity(prior, row)) {
      return null
    }
    merged.set(row.pid, row)
  }
  for (const row of next) {
    const prior = merged.get(row.pid)
    if (prior && !sameIdentity(prior, row)) {
      return null
    }
    merged.set(row.pid, row)
  }
  return [...merged.values()]
}

export function mergeClaudeCapturedTrees(
  previous: ClaudeCapturedTree,
  next: ClaudeCapturedTree
): ClaudeCapturedTree | null {
  if (previous.platform !== next.platform) {
    return null
  }
  if (previous.platform === 'posix' && next.platform === 'posix') {
    if (previous.tree.rootPgid !== next.tree.rootPgid) {
      return null
    }
    const descendants = mergeRowsByPid(
      previous.tree.descendants,
      next.tree.descendants,
      (left, right) => left.pgid === right.pgid && left.startedAt === right.startedAt
    )
    if (!descendants) {
      return null
    }
    return {
      platform: 'posix',
      tree: {
        ...next.tree,
        // A retained row keeps the earlier process-table boundary. A later
        // displayed second must not make same-second PID reuse force-killable.
        capturedAtMs: Math.min(previous.tree.capturedAtMs, next.tree.capturedAtMs),
        descendants
      }
    }
  }
  if (previous.platform === 'win32' && next.platform === 'win32') {
    if (
      previous.tree.root.pid !== next.tree.root.pid ||
      previous.tree.root.creationTimeMs !== next.tree.root.creationTimeMs
    ) {
      return null
    }
    const descendants = mergeRowsByPid(
      previous.tree.descendants,
      next.tree.descendants,
      (left, right) => left.creationTimeMs === right.creationTimeMs
    )
    if (!descendants) {
      return null
    }
    return {
      platform: 'win32',
      tree: {
        ...next.tree,
        capturedAtMs: Math.min(previous.tree.capturedAtMs, next.tree.capturedAtMs),
        descendants,
        unidentifiedCount: Math.max(previous.tree.unidentifiedCount, next.tree.unidentifiedCount)
      }
    }
  }
  return null
}
