import { lstat, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { AgentSessionJournalError } from './journal-write-guards'

/** Counts every physical file owned by one session: the database and its `-wal`
 * / `-shm` sidecars, blobs, and durable write temps. Symlinks are charged as
 * files but never followed outside the journal directory. */
export async function journalDirectoryBytes(directory: string): Promise<number> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }
  let total = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? await journalDirectoryBytes(path) : (await lstat(path)).size
  }
  return total
}

export async function assertJournalPhysicalCapacity(input: {
  journalDir: string
  sessionId: string
  maxBytes: number
  peakAdditionalBytes?: number
  /** The substrate's own floor. A quota below it cannot open a database, hold
   *  one row, and still reclaim, so it fails loudly at open instead of as an
   *  unbounded run of identical append failures. */
  minBytes?: number
}): Promise<number> {
  if (input.minBytes !== undefined && input.maxBytes < input.minBytes) {
    throw new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal for ${input.sessionId} needs at least ${input.minBytes} physical bytes; ${input.maxBytes} was configured`
    )
  }
  const current = await journalDirectoryBytes(input.journalDir)
  if (current + (input.peakAdditionalBytes ?? 0) > input.maxBytes) {
    throw new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal for ${input.sessionId} reached its ${input.maxBytes}-byte physical bound`
    )
  }
  return current
}
