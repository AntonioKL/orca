import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'

export const AGENT_HOOK_SPOOL_MAX_BYTES = 5 * 1024 * 1024
export const AGENT_HOOK_SPOOL_MAX_FILES = 1024
export const AGENT_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type SpoolRecord = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  env?: string
  version?: string
  launchToken?: string
  hookEventName?: string
  source: string
  payload: unknown
  receivedAt: number
  [key: string]: unknown
}

export function launchTokenHash(token: string | undefined): string | null {
  return token?.trim() ? createHash('sha256').update(token.trim()).digest('hex') : null
}

export function readSpoolRecords(path: string, now = Date.now()): SpoolRecord[] {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return []
  }
  const records: SpoolRecord[] = []
  let start = 0
  for (let end = 0; end <= bytes.length; end += 1) {
    if (end !== bytes.length && bytes[end] !== 0x0a) {
      continue
    }
    const lineBytes = bytes.subarray(start, end)
    start = end + 1
    if (lineBytes.length === 0) {
      continue
    }
    try {
      const value = JSON.parse(lineBytes.toString('utf8')) as Partial<SpoolRecord>
      if (
        typeof value.paneKey === 'string' &&
        typeof value.source === 'string' &&
        value.payload !== undefined &&
        typeof value.receivedAt === 'number' &&
        value.receivedAt >= now - AGENT_HOOK_SPOOL_MAX_AGE_MS
      ) {
        records.push(value as SpoolRecord)
      }
    } catch {
      // Torn lines are discarded while later complete lines remain replayable.
    }
  }
  return records
}

export type SpoolDrainOptions = {
  endpointDir: string
  getPersistedLaunchTokenHash: (paneKey: string) => string | undefined
  ingest: (record: SpoolRecord) => void
  now?: number
}

/** Drain JSONL files in place; never replace or unlink an inode held by a hook writer. */
export function drainAgentHookSpool(options: SpoolDrainOptions): number {
  const spoolDir = join(options.endpointDir, 'spool')
  let names: string[]
  try {
    names = readdirSync(spoolDir)
  } catch {
    return 0
  }
  const now = options.now ?? Date.now()
  const candidates = names
    .map((name) => {
      const path = join(spoolDir, name)
      try {
        const stat = statSync(path)
        return stat.isFile() ? { path, mtimeMs: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, AGENT_HOOK_SPOOL_MAX_FILES)
  let drained = 0
  for (const candidate of candidates) {
    for (const record of readSpoolRecords(candidate.path, now)) {
      const expected = options.getPersistedLaunchTokenHash(record.paneKey)
      const actual = launchTokenHash(record.launchToken)
      if (expected && actual !== expected) {
        continue
      }
      options.ingest({ ...record, isReplay: true })
      drained += 1
    }
    try {
      const fd = openSync(candidate.path, 'r+')
      try {
        // Keep the inode so a concurrent append handle cannot silently orphan writes.
        ftruncateSync(fd, 0)
      } finally {
        // fstat keeps the descriptor operation observable in tests and documents the inode contract.
        fstatSync(fd)
        closeSync(fd)
      }
    } catch {
      // A concurrently removed or inaccessible file is harmless; the next launch retries it.
    }
  }
  return drained
}
