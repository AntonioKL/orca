import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import {
  checkpointJournalWal,
  journalReclaimBandBytes,
  journalTxnPhysicalCost,
  journalWalBytes,
  journalWalFrameBytes,
  JOURNAL_MIN_SESSION_BYTES,
  reclaimJournalDatabaseSpace
} from './journal-database-space'
import { journalDatabaseFile } from './journal-paths'
import { journalDirectoryBytes } from './journal-physical-quota'
import { deleteAllJournalRows, journalFreelistCount } from './journal-row-table'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

let root: string
let dbPath: string
let opened: OpenJournalDatabase

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Writes one transaction of `sizes` rows and returns the largest directory
 *  footprint it reached, including the moment the WAL and the database hold the
 *  same pages at once. */
async function observedPeakDelta(sizes: readonly number[], firstSeq: number): Promise<number> {
  const before = await journalDirectoryBytes(root)
  const insert = opened.db.prepare(
    'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
  )
  opened.db.exec('BEGIN IMMEDIATE')
  sizes.forEach((bytes, index) => {
    insert.run('session-1', 'epoch-1', firstSeq + index, 1, 'x'.repeat(bytes))
  })
  opened.db.exec('COMMIT')
  const committed = await journalDirectoryBytes(root)
  const walAfterCommit = await fileSize(`${dbPath}-wal`)
  checkpointJournalWal(opened.db)
  const settled = await journalDirectoryBytes(root)
  const midCheckpoint =
    (await fileSize(dbPath)) + walAfterCommit + (await fileSize(`${dbPath}-shm`))
  return Math.max(committed, settled, midCheckpoint) - before
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-space-'))
  dbPath = journalDatabaseFile(root)
  opened = openJournalDatabase(dbPath)
})

afterEach(async () => {
  try {
    opened.db.close()
  } catch {
    // Already closed by the case.
  }
  await rm(root, { recursive: true, force: true })
})

describe('journalTxnPhysicalCost', () => {
  it('is the documented page arithmetic at the default page size', () => {
    expect(journalWalFrameBytes(4096)).toBe(4120)
    expect(journalTxnPhysicalCost([120], 4096)).toBe(222_480)
    expect(journalTxnPhysicalCost([32 * 1024], 4096)).toBe(288_400)
    expect(journalTxnPhysicalCost([64 * 1024], 4096)).toBe(354_320)
    expect(journalTxnPhysicalCost([128 * 1024], 4096)).toBe(486_160)
  })

  it('is monotone non-decreasing in row bytes, which is what a reservation rests on', () => {
    let previous = 0
    for (const bytes of [0, 1, 100, 4096, 65_536, 1_000_000]) {
      const cost = journalTxnPhysicalCost([bytes], 4096)
      expect(cost).toBeGreaterThanOrEqual(previous)
      previous = cost
    }
  })

  // Why: the whole hard-bound claim rests on the charge never being below what a
  // transaction actually costs on disk.
  it('never falls below the observed peak, on a fresh and on a grown database', async () => {
    const singles = [
      1,
      50,
      200,
      1000,
      4096,
      8192,
      16_384,
      65_536,
      262_144,
      1_048_576,
      MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
      4_000_000,
      10 * 1024 * 1024,
      40 * 1024 * 1024
    ]
    const batches = [
      Array.from({ length: 2 }, () => 200),
      Array.from({ length: 6 }, () => 200),
      Array.from({ length: 20 }, () => 4096),
      Array.from({ length: 200 }, () => 200),
      Array.from({ length: 1000 }, () => 200),
      Array.from({ length: 6 }, () => 1_499_000),
      Array.from({ length: 200 }, (_, index) => (index % 7) * 9000 + 1)
    ]
    const cases = [...singles.map((bytes) => [bytes]), ...batches]
    let seq = 1
    const misses: unknown[] = []
    for (let pass = 0; pass < 2; pass += 1) {
      for (const sizes of cases) {
        // Small transactions repeat so the tree deepens under them; the giant
        // ones run once a pass because each costs its own size on disk.
        const repeats = sizes[0] <= 1_048_576 ? 3 : 1
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          const charge = journalTxnPhysicalCost(sizes, opened.pageSize)
          const observed = await observedPeakDelta(sizes, seq)
          seq += sizes.length
          if (charge < observed) {
            misses.push({ pass, rows: sizes.length, first: sizes[0], charge, observed })
          }
        }
      }
    }
    expect(misses).toEqual([])
  }, 300_000)
})

describe('journalReclaimBandBytes', () => {
  it('is proportional, with a floor that covers a first reclaim chunk', () => {
    expect(journalReclaimBandBytes(0, 4096)).toBe(65_920)
    expect(journalReclaimBandBytes(268_435_456, 4096)).toBe(1_048_576)
    expect(JOURNAL_MIN_SESSION_BYTES).toBe(524_288)
  })
})

describe('reclaimJournalDatabaseSpace', () => {
  async function fill(rows: number): Promise<void> {
    const insert = opened.db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    opened.db.exec('BEGIN IMMEDIATE')
    for (let seq = 1; seq <= rows; seq += 1) {
      insert.run('session-1', 'epoch-1', seq, 1, 'y'.repeat(2000))
    }
    opened.db.exec('COMMIT')
    checkpointJournalWal(opened.db)
  }

  it('returns the freelist to zero, shrinks the file, and never grows past its start', async () => {
    await fill(8000)
    const grown = await journalDirectoryBytes(root)
    deleteAllJournalRows(opened.db)
    checkpointJournalWal(opened.db)
    expect(journalFreelistCount(opened.db)).toBeGreaterThan(0)
    const start = await journalDirectoryBytes(root)

    await reclaimJournalDatabaseSpace({
      db: opened.db,
      journalDir: root,
      dbPath,
      maxBytes: grown * 2,
      pageSize: opened.pageSize
    })
    expect(journalFreelistCount(opened.db)).toBe(0)
    expect(await journalDirectoryBytes(root)).toBeLessThan(start)
  }, 120_000)

  // Why: a single-step invocation frees exactly ONE page regardless of N, which
  // leaves every size assertion green while reclamation recovers almost nothing.
  it('steps the vacuum to completion rather than freeing one page', async () => {
    await fill(4000)
    deleteAllJournalRows(opened.db)
    checkpointJournalWal(opened.db)
    const before = journalFreelistCount(opened.db)
    expect(before).toBeGreaterThan(50)
    opened.db.pragma('incremental_vacuum(50)')
    expect(before - journalFreelistCount(opened.db)).toBe(50)
  }, 60_000)

  it('declines to start while a reader holds the WAL open, and drains after it leaves', async () => {
    await fill(4000)
    const grown = await journalDirectoryBytes(root)
    deleteAllJournalRows(opened.db)
    const reader = openJournalDatabase(dbPath)
    reader.db.exec('BEGIN')
    reader.db.prepare('SELECT count(*) AS total FROM journal_rows').all()
    checkpointJournalWal(opened.db)
    expect(await journalWalBytes(dbPath)).toBeGreaterThan(0)

    await reclaimJournalDatabaseSpace({
      db: opened.db,
      journalDir: root,
      dbPath,
      maxBytes: grown * 2,
      pageSize: opened.pageSize
    })
    // The bytes are deferred, not lost.
    expect(journalFreelistCount(opened.db)).toBeGreaterThan(0)
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(grown * 2)

    reader.db.exec('ROLLBACK')
    reader.db.close()
    checkpointJournalWal(opened.db)
    await reclaimJournalDatabaseSpace({
      db: opened.db,
      journalDir: root,
      dbPath,
      maxBytes: grown * 2,
      pageSize: opened.pageSize
    })
    expect(journalFreelistCount(opened.db)).toBe(0)
  }, 120_000)

  it('stops instead of writing when there is no headroom', async () => {
    await fill(4000)
    deleteAllJournalRows(opened.db)
    checkpointJournalWal(opened.db)
    const start = await journalDirectoryBytes(root)
    const freelist = journalFreelistCount(opened.db)
    await reclaimJournalDatabaseSpace({
      db: opened.db,
      journalDir: root,
      dbPath,
      maxBytes: start,
      pageSize: opened.pageSize
    })
    expect(journalFreelistCount(opened.db)).toBe(freelist)
    expect(await journalDirectoryBytes(root)).toBe(start)
  }, 60_000)
})
