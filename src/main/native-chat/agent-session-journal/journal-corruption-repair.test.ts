// A repair may hide history. It may never destroy it.
//
// Two things make a suffix unreplayable: a row this build cannot parse, and a
// sequence gap that makes every later row unanchored. In both cases the rows
// PAST the fault are usually intact, and the Orca-owned ones — a submission,
// its acceptance receipt, a lifecycle mutation — carry identity Orca minted and
// no provider transcript can reconstruct. Deleting them is unrecoverable data
// loss; setting them aside is a rendering decision the user can come back from.
//
// Every case here therefore asserts the same two halves: the live epoch shows
// only the replayable prefix, AND the rejected rows are readable verbatim
// afterwards.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { journalTxnPhysicalCost } from './journal-database-space'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { countJournalRowSuffix } from './journal-row-table'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

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

async function withJournalDatabase(run: (db: Database.Database) => void): Promise<void> {
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    run(opened.db)
  } finally {
    opened.db.close()
  }
}

function liveSequences(): Promise<number[]> {
  let sequences: number[] = []
  return withJournalDatabase((db) => {
    sequences = (
      db.prepare('SELECT seq FROM journal_rows ORDER BY seq').all() as { seq: number }[]
    ).map((row) => row.seq)
  }).then(() => sequences)
}

/** The quarantined rows, parsed back through the SAME reader replay uses. */
function recovered(journal: { recoverQuarantinedRows: () => { rowJson: string }[] }): JournalRow[] {
  const rows: JournalRow[] = []
  for (const stored of journal.recoverQuarantinedRows()) {
    const parsed = parseJournalRow(stored.rowJson)
    if (parsed.ok) {
      rows.push(parsed.row)
    }
  }
  return rows
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-repair-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a malformed row', () => {
  it('keeps the readable prefix live and preserves the row it could not read', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('readable'), { fence: 1 })
    await journal.appendItem(item(1), body('unreadable'), { fence: 1 })
    await journal.appendItem(item(2), body('after the fault'), { fence: 1 })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run('{"not":"a row"}', 3)
    })

    const reopened = await open()
    expect(reopened.repair.malformedRows).toBe(1)
    expect(reopened.repair.quarantinedRows).toBe(2)

    // The malformed row AND the valid one behind it are both readable again.
    const preserved = reopened.recoverQuarantinedRows()
    expect(preserved.map((row) => row.seq)).toEqual([3, 4])
    expect(preserved[0]?.rowJson).toBe('{"not":"a row"}')
    expect(recovered(reopened).map((row) => row.kind)).toEqual(['item'])
  })

  it('discloses the repair as preserved rather than as skipped bytes', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('readable'), { fence: 1 })
    await journal.appendItem(item(1), body('later'), { fence: 1 })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run('}{', 2)
    })

    const reopened = await open()
    const disclosure = reopened
      .snapshot()
      .items.map((entry) => entry.body)
      .find((entry) => entry.kind === 'status')
    expect(disclosure).toMatchObject({ kind: 'status' })
    expect(disclosure && 'text' in disclosure ? disclosure.text : '').toContain(
      'set aside and remain recoverable'
    )
  })
})

describe('a sequence gap', () => {
  it('preserves every valid row after the hole', async () => {
    const journal = await open()
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      await journal.appendItem(item(ordinal), body(`m${ordinal}`), { fence: 1 })
    }
    await journal.close()
    // Sequence 1 is the epoch row, so the items occupy 2..6. Removing 4 leaves
    // 5 and 6 valid but unanchored.
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(4)
    })

    const reopened = await open()
    expect(await liveSequences()).toEqual([1, 2, 3])
    expect(reopened.repair).toEqual({ malformedRows: 0, quarantinedRows: 2 })
    expect(recovered(reopened).map((row) => (row.kind === 'item' ? row.body : null))).toEqual([
      body('m3'),
      body('m4')
    ])
  })

  it('keeps Orca-owned submission, receipt and lifecycle identity recoverable', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('anchor'), { fence: 1 })
    await journal.appendSubmission({
      clientMessageId: 'client-message-1',
      payloadFingerprint: 'fingerprint-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'the user typed this' }]
      },
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'client-message-1',
      state: 'accepted',
      providerIdentity: item(1),
      fence: 1
    })
    await journal.close()
    // Punch the hole directly BEFORE the submission, so both Orca-owned rows
    // land in the rejected suffix.
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(2)
    })

    const reopened = await open()
    expect(reopened.repair.quarantinedRows).toBe(2)
    const rows = recovered(reopened)
    expect(rows.map((row) => row.kind)).toEqual(['submission', 'dispatch'])

    // The client message id is what makes a resend idempotent, and only Orca
    // ever minted it: a provider transcript cannot supply it back.
    const submission = rows.find((row) => row.kind === 'submission')
    expect(submission && 'clientMessageId' in submission ? submission.clientMessageId : null).toBe(
      'client-message-1'
    )
    const dispatch = rows.find((row) => row.kind === 'dispatch')
    expect(dispatch && 'clientMessageId' in dispatch ? dispatch.clientMessageId : null).toBe(
      'client-message-1'
    )
  })
})

describe('the quota', () => {
  // Why this refuses rather than degrading: preserving the suffix is the whole
  // contract. A journal that cannot afford the copy must not fall back to the
  // destructive path it was written to replace.
  it('refuses to open rather than destroying a suffix it cannot afford to preserve', async () => {
    const journal = await open()
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      await journal.appendItem(item(ordinal), body('x'.repeat(64_000)), { fence: 1 })
    }
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(3)
    })

    // The bound is derived from the charge the repair will actually compute, so
    // this case cannot drift into passing because the numbers moved.
    let charge = 0
    let pageSize = 4096
    await withJournalDatabase((db) => {
      const opened = openJournalDatabase(journalDatabaseFile(root))
      pageSize = opened.pageSize
      opened.db.close()
      charge = journalTxnPhysicalCost(
        countJournalRowSuffix(db, IDENTITY.sessionId, 'epoch-1000', 4).rowJsonByteLengths,
        pageSize
      )
    })
    const measured = await journalDirectoryBytes(root)
    expect(charge).toBeGreaterThan(0)

    await expect(
      open({
        limits: {
          ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
          maxSessionBytes: measured + charge - 1
        }
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    // Nothing was dropped on the way to that refusal.
    expect(await liveSequences()).toEqual([1, 2, 4, 5])
  })
})
