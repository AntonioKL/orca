// A successful COMMIT is the point of no return.
//
// Every write path here does fallible filesystem work AFTER its transaction
// commits — a directory scan on the ordinary append, checkpoint/reclaim/prune on
// the two epoch paths. If that work can make the caller believe the transaction
// did not land, disk and memory diverge in the worst possible direction: the
// row is durable but the in-memory sequence never advanced, so the next append
// reuses a sequence the table already holds; the epoch is durable but the store
// still points at a prefix that has just been deleted, so the next append
// resurrects it through the projection upsert.
//
// Each case injects the real post-COMMIT failure and then asserts the two
// things that prove adoption happened anyway: the operation reports the truth,
// and the NEXT append uses the next sequence in the current epoch.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import type * as JournalDatabaseSpace from './journal-database-space'
import type * as JournalPhysicalQuota from './journal-physical-quota'
import { journalDatabaseFile } from './journal-paths'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

const injected = vi.hoisted(() => ({
  /** Successful scans to allow before the next one throws; null disarms. */
  scanFailsAfter: null as number | null,
  scans: 0,
  reclaimFails: false
}))

vi.mock('./journal-physical-quota', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalPhysicalQuota>()
  return {
    ...actual,
    journalDirectoryBytes: async (directory: string) => {
      if (injected.scanFailsAfter !== null && injected.scans >= injected.scanFailsAfter) {
        throw new Error('post-commit directory scan failed')
      }
      injected.scans += 1
      return actual.journalDirectoryBytes(directory)
    }
  }
})

vi.mock('./journal-database-space', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalDatabaseSpace>()
  return {
    ...actual,
    reclaimJournalDatabaseSpace: async (
      input: Parameters<typeof actual.reclaimJournalDatabaseSpace>[0]
    ) => {
      if (injected.reclaimFails) {
        throw new Error('post-commit reclamation failed')
      }
      return actual.reclaimJournalDatabaseSpace(input)
    }
  }
})

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

/** Reads the durable truth on its own connection, so no assertion here can be
 *  satisfied by in-memory state alone. */
async function withJournalDatabase(run: (db: Database.Database) => void): Promise<void> {
  const { openJournalDatabase } = await import('./journal-database')
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    run(opened.db)
  } finally {
    opened.db.close()
  }
}

async function storedRows(): Promise<{ epoch: string; seq: number }[]> {
  let rows: { epoch: string; seq: number }[] = []
  await withJournalDatabase((db) => {
    rows = db.prepare('SELECT epoch, seq FROM journal_rows ORDER BY epoch, seq').all() as {
      epoch: string
      seq: number
    }[]
  })
  return rows
}

async function projectedEpoch(): Promise<string | undefined> {
  let epoch: string | undefined
  await withJournalDatabase((db) => {
    epoch = (
      db
        .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
        .get(IDENTITY.sessionId) as { epoch: string } | undefined
    )?.epoch
  })
  return epoch
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-post-commit-'))
  clock = 1_000
  injected.scanFailsAfter = null
  injected.scans = 0
  injected.reclaimFails = false
})

afterEach(async () => {
  injected.scanFailsAfter = null
  injected.reclaimFails = false
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the ordinary append', () => {
  // Why the append RESOLVING is the proof: the writer scans the directory once
  // before the transaction and once after it, so a failure armed for the second
  // scan can only be observed post-COMMIT. Arming it too early would reject the
  // append instead, and this case would fail rather than pass vacuously.
  it('adopts the durable row when the post-commit scan fails, and never reuses its sequence', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('committed'), { fence: 1 })

    injected.scans = 0
    injected.scanFailsAfter = 1
    await expect(
      journal.appendItem(item(1), body('scan fails'), { fence: 1 })
    ).resolves.toMatchObject({ cursor: { sequence: 3 } })
    injected.scanFailsAfter = null

    // The sequence advanced with the durable row, so the next append does not
    // collide with it on the primary key.
    await expect(journal.appendItem(item(2), body('after'), { fence: 1 })).resolves.toMatchObject({
      cursor: { sequence: 4 }
    })
    expect((await storedRows()).map((row) => row.seq)).toEqual([1, 2, 3, 4])
  })

  it('carries a conservative footprint forward when the scan cannot answer', async () => {
    const journal = await open()
    injected.scans = 0
    injected.scanFailsAfter = 1
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    injected.scanFailsAfter = null

    // The projection is an upper bound, so admission still fails closed: a
    // journal whose bound is already spent refuses the next append.
    await expect(journal.appendItem(item(1), body('b'), { fence: 1 })).resolves.toMatchObject({
      cursor: { sequence: 3 }
    })
  })
})

describe('an epoch roll', () => {
  it('adopts the published epoch when post-commit reclamation fails', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('superseded'), { fence: 1 })
    const superseded = journal.epoch

    injected.reclaimFails = true
    const rolled = await journal.rollEpoch('handle_forked', 2)
    injected.reclaimFails = false

    expect(rolled.epoch).not.toBe(superseded)
    expect(journal.epoch).toBe(rolled.epoch)
    expect(await projectedEpoch()).toBe(rolled.epoch)

    // The append lands in the epoch that is actually on disk. Against the
    // pre-fix code the store still held `superseded`, whose rows the roll had
    // already deleted, and this append moved the projection back onto it.
    await journal.appendItem(item(1), body('after the roll'), { fence: 2 })
    expect(await storedRows()).toEqual([
      { epoch: rolled.epoch, seq: 1 },
      { epoch: rolled.epoch, seq: 2 }
    ])
    expect(await projectedEpoch()).toBe(rolled.epoch)

    const reopened = await open()
    expect(reopened.epoch).toBe(rolled.epoch)
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('after the roll')])
  })
})

describe('an epoch replacement', () => {
  it('adopts the replacement epoch when post-commit reclamation fails', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('superseded'), { fence: 1 })
    const superseded = journal.epoch

    injected.reclaimFails = true
    const replaced = await journal.replaceEpochItems('legacy_import', 2, [
      { identity: item(7), body: body('rehydrated') }
    ])
    injected.reclaimFails = false

    expect(replaced.epoch).not.toBe(superseded)
    expect(journal.epoch).toBe(replaced.epoch)
    expect(await projectedEpoch()).toBe(replaced.epoch)

    await journal.appendItem(item(8), body('after the replacement'), { fence: 2 })
    expect(await storedRows()).toEqual([
      { epoch: replaced.epoch, seq: 1 },
      { epoch: replaced.epoch, seq: 2 },
      { epoch: replaced.epoch, seq: 3 }
    ])

    const reopened = await open()
    expect(reopened.epoch).toBe(replaced.epoch)
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
      body('rehydrated'),
      body('after the replacement')
    ])
  })
})
