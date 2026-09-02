import type { DescendantTreeVerdict } from './pty-descendant-exit-verification'
import { queryWindowsProcessDescendants } from './providers/windows-foreground-process-rows'
import { readWindowsProcessTableFresh } from './windows/windows-process-table'

export const WINDOWS_DESCENDANT_KILL_VERIFY_MS = 3_500
const WINDOWS_DESCENDANT_POLL_MS = 100

/**
 * A Windows descendant tree captured while its root was alive, with the
 * PID-reuse guard the POSIX snapshot gets from ps lstart: a row only counts as
 * the same process when its creation time still matches. Rows without a
 * creation time are omitted, because a bare pid cannot be re-identified.
 */
export type WindowsDescendantSnapshot = {
  descendants: { pid: number; creationTimeMs: number }[]
  capturedAtMs: number
}

export type WindowsDescendantVerificationDeps = {
  readDescendants?: (rootPid: number) => Promise<{ pid: number }[] | null>
  readTable?: () => Promise<{ pid: number; creationTimeMs?: number }[]>
  now?: () => number
  wait?: (ms: number) => Promise<void>
  verifyMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Snapshot a Windows root's descendants while it is still alive. Resolves null
 * (never rejects) when the table is unreadable or the root is absent — the same
 * contract as the POSIX walk, because "cannot see" is never "nothing is there".
 */
export async function captureWindowsDescendantSnapshot(
  rootPid: number,
  deps: WindowsDescendantVerificationDeps = {}
): Promise<WindowsDescendantSnapshot | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const capturedAtMs = (deps.now ?? Date.now)()
  const descendants = await (
    deps.readDescendants ?? ((pid: number) => queryWindowsProcessDescendants(pid, { fresh: true }))
  )(rootPid).catch(() => null)
  if (!descendants) {
    return null
  }
  const rows = await readIdentifiedRows(descendants, deps)
  return rows && { descendants: rows, capturedAtMs }
}

async function readIdentifiedRows(
  descendants: { pid: number }[],
  deps: WindowsDescendantVerificationDeps
): Promise<{ pid: number; creationTimeMs: number }[] | null> {
  const wanted = new Set(descendants.map((row) => row.pid))
  if (wanted.size === 0) {
    return []
  }
  const table = await (deps.readTable ?? readWindowsProcessTableFresh)().catch(() => null)
  if (!table) {
    return null
  }
  const identified: { pid: number; creationTimeMs: number }[] = []
  for (const row of table) {
    if (wanted.has(row.pid) && typeof row.creationTimeMs === 'number') {
      identified.push({ pid: row.pid, creationTimeMs: row.creationTimeMs })
    }
  }
  return identified
}

/**
 * Whether a snapshotted Windows tree is gone, polled to a bounded deadline.
 *
 * Why a verification pass at all: `taskkill /T /F` resolves the same way on a
 * timeout, an access denial and a recycled root as it does on a successful
 * kill, so its completion is never evidence. Only a table read that no longer
 * shows an identity-matched row is.
 */
export async function verifyWindowsDescendantSnapshotExit(
  snapshot: WindowsDescendantSnapshot,
  deps: WindowsDescendantVerificationDeps = {}
): Promise<DescendantTreeVerdict> {
  if (snapshot.descendants.length === 0) {
    return 'exited'
  }
  const now = deps.now ?? Date.now
  const readTable = deps.readTable ?? readWindowsProcessTableFresh
  const deadline = now() + (deps.verifyMs ?? WINDOWS_DESCENDANT_KILL_VERIFY_MS)
  let verdict: DescendantTreeVerdict = 'unverifiable'
  do {
    const table = await readTable().catch(() => null)
    if (!table) {
      verdict = 'unverifiable'
    } else {
      const live = new Map(table.map((row) => [row.pid, row.creationTimeMs]))
      verdict = snapshot.descendants.some((row) => live.get(row.pid) === row.creationTimeMs)
        ? 'live'
        : 'exited'
      if (verdict === 'exited') {
        return verdict
      }
    }
    if (now() >= deadline) {
      return verdict
    }
    await (deps.wait ?? delay)(WINDOWS_DESCENDANT_POLL_MS)
  } while (now() < deadline)
  return verdict
}
