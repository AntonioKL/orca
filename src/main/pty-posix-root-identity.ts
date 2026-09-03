import {
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  readProcessTable,
  readProcessTableBeforeDeadline,
  type ProcessTableReader,
  type PosixProcessIdentity
} from './pty-descendant-termination'

/** Revalidate a POSIX root PID/start-time immediately before a kill. */
export async function verifyPosixProcessIdentity(
  target: PosixProcessIdentity,
  deps: { readTable?: ProcessTableReader; timeoutMs?: number } = {}
): Promise<boolean> {
  if (!Number.isInteger(target.pid) || target.pid <= 0 || !target.startedAt) {
    return false
  }
  const capture = await readProcessTableBeforeDeadline(
    deps.readTable ?? readProcessTable,
    deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  )
  const current = capture?.rows.filter((row) => row.pid === target.pid) ?? []
  return current.length === 1 && current[0]?.startedAt === target.startedAt
}

export type { PosixProcessIdentity }
