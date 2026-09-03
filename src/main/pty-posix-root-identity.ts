import {
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  hasUnambiguousStartTime,
  readProcessTable,
  readProcessTableBeforeDeadline,
  type ProcessTableReader,
  type PosixProcessIdentity
} from './pty-descendant-termination'

/** Revalidate a POSIX root PID/start-time immediately before a kill. */
export async function verifyPosixProcessIdentity(
  target: PosixProcessIdentity,
  deps: { readTable?: ProcessTableReader; timeoutMs?: number; capturedAtMs?: number } = {}
): Promise<boolean> {
  if (!Number.isInteger(target.pid) || target.pid <= 0 || !target.startedAt) {
    return false
  }
  // ps lstart has one-second precision. A root born in its capture second may
  // be a recycled process with the same displayed start time, so it is never
  // eligible for a direct PID kill without a stronger OS identity API.
  const capturedAtMs = deps.capturedAtMs
  if (
    typeof capturedAtMs !== 'number' ||
    !Number.isFinite(capturedAtMs) ||
    !hasUnambiguousStartTime(target.startedAt, capturedAtMs)
  ) {
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
