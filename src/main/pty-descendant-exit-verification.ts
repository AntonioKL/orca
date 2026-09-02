import {
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  hasUnambiguousStartIdentity,
  readProcessTable,
  readProcessTableBeforeDeadline,
  sendDescendantSignal,
  type DescendantSnapshot,
  type ProcessTableRow,
  type TerminateDeps
} from './pty-descendant-termination'

export const DESCENDANT_KILL_VERIFY_MS = 3_500

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function matchingSnapshotRows(
  snapshot: DescendantSnapshot,
  table: readonly ProcessTableRow[]
): ProcessTableRow[] {
  const expected = new Map(snapshot.descendants.map((row) => [row.pid, row]))
  return table.filter((live) => {
    const row = expected.get(live.pid)
    return row?.startedAt === live.startedAt && row.pgid === live.pgid
  })
}

type VerificationDeps = TerminateDeps & {
  verifyMs?: number
}

/**
 * Orca's verdict vocabulary for a snapshotted tree, with no synonyms: `live` is
 * an identity-matched descendant still observed at the deadline; `unverifiable`
 * is a table that could not be read, which is never evidence either way.
 */
export type DescendantTreeVerdict = 'exited' | 'live' | 'unverifiable'

/** An unreadable process table is never proof that a stopped descendant exited. */
export async function terminateDescendantSnapshotAndWait(
  snapshot: DescendantSnapshot,
  deps: VerificationDeps = {}
): Promise<boolean> {
  return (await terminateDescendantSnapshotWithVerdict(snapshot, deps)) === 'exited'
}

/** Signals the snapshot, then reports what the last table read observed. */
export async function terminateDescendantSnapshotWithVerdict(
  snapshot: DescendantSnapshot,
  deps: VerificationDeps = {}
): Promise<DescendantTreeVerdict> {
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const readTable = deps.readTable ?? readProcessTable
  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  const verifyMs = deps.verifyMs ?? DESCENDANT_KILL_VERIFY_MS
  const deadline = Date.now() + verifyMs
  for (const row of snapshot.descendants) {
    sendSignal(row.pid, 'SIGTERM')
  }
  let forced = false
  while (Date.now() < deadline) {
    const capture = await readProcessTableBeforeDeadline(
      readTable,
      deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
    )
    // A read that missed its own deadline is not an answer, and surrendering on
    // the first slow one spends none of the window this verification was given:
    // on a loaded host that reported a tree unverifiable without ever seeing it.
    if (capture) {
      const live = matchingSnapshotRows(snapshot, capture.rows)
      if (live.length === 0) {
        return 'exited'
      }
      if (!forced && Date.now() >= deadline - verifyMs + graceMs) {
        forced = true
        for (const row of live) {
          if (hasUnambiguousStartIdentity(row, snapshot.capturedAtMs)) {
            sendSignal(row.pid, 'SIGKILL')
          }
        }
      }
    }
    await waitForDelay(50)
  }
  const finalCapture = await readProcessTableBeforeDeadline(
    readTable,
    deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  )
  if (!finalCapture) {
    return 'unverifiable'
  }
  return matchingSnapshotRows(snapshot, finalCapture.rows).length === 0 ? 'exited' : 'live'
}
