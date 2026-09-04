// The bound while a checkpoint CANNOT run.
//
// `wal_autocheckpoint = 0` suppresses automatic checkpoints; it does not make an
// explicit one succeed. A second connection holding a read transaction makes
// `wal_checkpoint(TRUNCATE)` return busy and leaves the WAL on disk TOGETHER
// with the database growth it already copied — so reading the settled size
// alone under-charges by up to the whole WAL.

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import { checkpointJournalWal, journalWalBytes } from './journal-database-space'
import { journalDatabaseFile } from './journal-paths'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { JournalPeakSampler } from './journal-quota-test-peak'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const MAX_BYTES = 8 * 1024 * 1024

let root: string
let reader: OpenJournalDatabase | null = null
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: MAX_BYTES }
  })
}

/** A second connection pinned inside a read transaction, which is exactly what
 *  a `loadJournal` probe against a live session's directory is. */
function holdReader(): void {
  reader = openJournalDatabase(journalDatabaseFile(root))
  reader.db.exec('BEGIN')
  reader.db.prepare('SELECT count(*) AS total FROM journal_rows').all()
}

function releaseReader(): void {
  if (!reader) {
    return
  }
  reader.db.exec('ROLLBACK')
  reader.db.close()
  reader = null
}

async function appendTail(
  journal: AgentSessionJournal,
  peak: JournalPeakSampler,
  count: number,
  size: number,
  firstOrdinal: number
): Promise<number[]> {
  const admitted: number[] = []
  for (let index = 0; index < count; index += 1) {
    const ordinal = firstOrdinal + index
    const landed = await journal
      .appendItem(item(ordinal), body('t'.repeat(size)), { fence: 1 })
      .then(() => true)
      .catch(() => false)
    if (landed) {
      admitted.push(ordinal)
    }
    await peak.sample()
  }
  return admitted
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-wal-'))
})

afterEach(async () => {
  releaseReader()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the bound holds while a checkpoint cannot run', () => {
  it('stays under the bound across a large row, a held reader, and a small-row tail', async () => {
    const journal = await openJournal()
    const peak = new JournalPeakSampler(root)
    await journal.appendItem(item(1), body('L'.repeat(1024 * 1024)), { fence: 1 })
    await peak.sample()
    holdReader()

    await appendTail(journal, peak, 60, 20_000, 100)
    expect(peak.peak).toBeLessThanOrEqual(MAX_BYTES)

    // Including across the checkpoint that finally lands once the reader leaves.
    releaseReader()
    await journal.appendItem(item(999), body('after'), { fence: 1 })
    await peak.sample()
    expect(peak.peak).toBeLessThanOrEqual(MAX_BYTES)
  }, 120_000)

  it('refuses earlier under a reader held for the whole run, with no new code path', async () => {
    holdReader()
    const journal = await openJournal()
    const peak = new JournalPeakSampler(root)
    const contended = await appendTail(journal, peak, 120, 40_000, 1)
    expect(peak.peak).toBeLessThanOrEqual(MAX_BYTES)
    expect(await journalWalBytes(journalDatabaseFile(root))).toBeGreaterThan(0)

    await expect(
      journal.appendItem(item(9999), body('x'.repeat(4 * 1024 * 1024)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    releaseReader()
    // The writer still holds `journal.db`. POSIX unlinks an open database
    // happily; Windows refuses, so the handle is released BEFORE the removal
    // and the removal itself is the assertion that nothing else holds it.
    await journal.close()
    await rm(root, { recursive: true, force: true })
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    root = await mkdtemp(join(tmpdir(), 'orca-journal-wal-'))
    const uncontended = await openJournal()
    const control = await appendTail(uncontended, new JournalPeakSampler(root), 120, 40_000, 1)
    expect(control.length).toBeGreaterThanOrEqual(contended.length)
  }, 120_000)

  // The control that proves the deferred-checkpoint term is FREE on the normal
  // path: with no reader the WAL is empty after every write, so the term is zero.
  it('leaves nothing deferred when no reader is held', async () => {
    const journal = await openJournal()
    for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
      await journal.appendItem(item(ordinal), body('c'.repeat(5000)), { fence: 1 })
      expect(await journalWalBytes(journalDatabaseFile(root))).toBe(0)
    }
  }, 60_000)

  it('returns promptly from a checkpoint a reader is blocking', async () => {
    const journal = await openJournal()
    await journal.appendItem(item(1), body('seed'), { fence: 1 })
    holdReader()
    const probe = openJournalDatabase(journalDatabaseFile(root))
    try {
      probe.db.exec("INSERT INTO journal_sessions VALUES ('other', 'epoch-x', 1)")
      const started = Date.now()
      checkpointJournalWal(probe.db)
      // `busy_timeout` is 5,000 ms and a blocked TRUNCATE would wait it out for
      // the byte-identical result it returns immediately without the handler.
      expect(Date.now() - started).toBeLessThan(2000)
      expect(await journalWalBytes(journalDatabaseFile(root))).toBeGreaterThan(0)
    } finally {
      probe.db.close()
    }
  }, 60_000)
})
