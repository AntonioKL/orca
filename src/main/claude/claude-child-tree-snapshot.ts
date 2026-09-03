import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'

/** One platform's descendant tree, tagged so neither verifier can be handed the other's rows. */
export type ClaudeCapturedTree =
  | { platform: 'posix'; tree: DescendantSnapshot }
  | { platform: 'win32'; tree: WindowsDescendantSnapshot }

/**
 * Process-table reads are not atomic: a refresh can omit a still-live row, but
 * it can also observe a new process after the old row exited. Keep the latest
 * identity for each PID and retain rows absent from the refresh so either case
 * remains in the close proof.
 */
function mergeRowsByPid<Row extends { pid: number }>(
  previous: readonly Row[],
  next: readonly Row[]
): Row[] {
  const merged = new Map<number, Row>()
  for (const row of previous) {
    merged.set(row.pid, row)
  }
  for (const row of next) {
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
    return {
      platform: 'posix',
      tree: {
        ...next.tree,
        descendants: mergeRowsByPid(previous.tree.descendants, next.tree.descendants)
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
    return {
      platform: 'win32',
      tree: {
        ...next.tree,
        descendants: mergeRowsByPid(previous.tree.descendants, next.tree.descendants),
        unidentifiedCount: Math.max(previous.tree.unidentifiedCount, next.tree.unidentifiedCount)
      }
    }
  }
  return null
}
