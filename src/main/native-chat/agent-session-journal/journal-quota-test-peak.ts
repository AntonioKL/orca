// Peak sampling for the physical-bound tests.
//
// "Peak" is not the settled size: the moment the WAL and the database hold the
// same pages is the largest the directory ever is, and a bound that only holds
// at rest is not a bound.

import { stat } from 'node:fs/promises'
import { journalDatabaseFile } from './journal-paths'
import { journalDirectoryBytes } from './journal-physical-quota'

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export class JournalPeakSampler {
  private worst = 0

  constructor(private readonly journalDir: string) {}

  get peak(): number {
    return this.worst
  }

  async sample(): Promise<number> {
    const dbPath = journalDatabaseFile(this.journalDir)
    const settled = await journalDirectoryBytes(this.journalDir)
    const midCheckpoint =
      (await fileSize(dbPath)) +
      (await fileSize(`${dbPath}-wal`)) +
      (await fileSize(`${dbPath}-shm`))
    this.worst = Math.max(this.worst, settled, midCheckpoint)
    return settled
  }
}
