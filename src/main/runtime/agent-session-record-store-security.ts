import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { scrubAgentSessionRecordLaunchEnv } from '../../shared/agent-session-launch-env-scrub'
import { durableWriteTempPath, renameDurable, writeTempFileDurable } from '../durable-file-write'
import {
  loadAgentSessionStore,
  type LoadedAgentSessionStore
} from './agent-session-record-store-file'
import { withAgentSessionStoreTransactionLock } from './agent-session-store-transaction-lock'

const OWNER_DIRECTORY_MODE = 0o700
const OWNER_FILE_MODE = 0o600

type PreparedScrub = { filePath: string; tmpPath: string; published: boolean }

function scrubRecordMap(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, changed: false }
  }
  let changed = false
  const entries = Object.entries(value).map(([sessionId, record]) => {
    const scrubbed = scrubAgentSessionRecordLaunchEnv(record)
    changed ||= scrubbed.changed
    return [sessionId, scrubbed.value]
  })
  return { value: changed ? Object.fromEntries(entries) : value, changed }
}

function scrubUnreadableRecordMap(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, changed: false }
  }
  let changed = false
  const entries = Object.entries(value).map(([sessionId, unusable]) => {
    if (typeof unusable !== 'object' || unusable === null || Array.isArray(unusable)) {
      return [sessionId, unusable]
    }
    const row = unusable as Record<string, unknown>
    const scrubbed = scrubAgentSessionRecordLaunchEnv(row.raw)
    changed ||= scrubbed.changed
    return [sessionId, scrubbed.changed ? { ...row, raw: scrubbed.value } : row]
  })
  return { value: changed ? Object.fromEntries(entries) : value, changed }
}

function scrubStorePayload(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const store = parsed as Record<string, unknown>
  if (!Number.isSafeInteger(store.schemaVersion) || (store.schemaVersion as number) < 0) {
    return null
  }
  const records = scrubRecordMap(store.records)
  const unreadableRecords = scrubUnreadableRecordMap(store.unusableRecords)
  if (!records.changed && !unreadableRecords.changed) {
    return null
  }
  return JSON.stringify({
    ...store,
    ...(records.changed ? { records: records.value } : {}),
    ...(unreadableRecords.changed ? { unusableRecords: unreadableRecords.value } : {})
  })
}

async function chmodIfPresent(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

export async function hardenAgentSessionStorePermissions(filePath: string): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE })
  await chmod(directory, OWNER_DIRECTORY_MODE)
  await Promise.all([
    chmodIfPresent(filePath, OWNER_FILE_MODE),
    chmodIfPresent(`${filePath}.bak`, OWNER_FILE_MODE)
  ])
}

async function prepareScrub(filePath: string): Promise<PreparedScrub | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  const payload = scrubStorePayload(raw)
  if (payload === null) {
    return null
  }
  const tmpPath = durableWriteTempPath(filePath)
  await writeTempFileDurable(tmpPath, payload, OWNER_FILE_MODE)
  return { filePath, tmpPath, published: false }
}

/** Scrubs each committed generation independently so backup-only sessions survive. */
export async function scrubAgentSessionStoreFiles(filePath: string): Promise<void> {
  const prepared: PreparedScrub[] = []
  try {
    for (const candidate of [`${filePath}.bak`, filePath]) {
      const scrub = await prepareScrub(candidate)
      if (scrub) {
        prepared.push(scrub)
      }
    }
    // Both replacements are durable first; publishing backup then live never removes the live path.
    for (const scrub of prepared) {
      await renameDurable(scrub.tmpPath, scrub.filePath)
      scrub.published = true
    }
  } finally {
    await Promise.all(
      prepared
        .filter((scrub) => !scrub.published)
        .map((scrub) => rm(scrub.tmpPath, { force: true }).catch(() => {}))
    )
  }
}

export async function loadProtectedAgentSessionStore(
  filePath: string,
  hostId: string
): Promise<LoadedAgentSessionStore> {
  return withAgentSessionStoreTransactionLock(filePath, async () => {
    await hardenAgentSessionStorePermissions(filePath)
    await scrubAgentSessionStoreFiles(filePath)
    await hardenAgentSessionStorePermissions(filePath)
    return loadAgentSessionStore(filePath, hostId)
  })
}
