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
import { JOURNAL_MIN_SESSION_BYTES, journalTxnPhysicalCost } from './journal-database-space'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { JournalPeakSampler } from './journal-quota-test-peak'
import { countJournalRowSuffix } from './journal-row-table'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { loadJournal } from './journal-open'
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

/** The row replay anchors on, parsed exactly as replay parses it. */
function firstLiveRow(): Promise<JournalRow | null> {
  let row: JournalRow | null = null
  return withJournalDatabase((db) => {
    const stored = db.prepare('SELECT row_json FROM journal_rows ORDER BY seq LIMIT 1').get() as
      | { row_json: string }
      | undefined
    const parsed = stored ? parseJournalRow(stored.row_json) : null
    row = parsed?.ok ? parsed.row : null
  }).then(() => row)
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
    // 1..3 is the surviving prefix; 4 is the disclosure the repair appends. A
    // gap sets aside valid rows and no line was unreadable, so this is the case
    // that used to hide the repair entirely.
    expect(await liveSequences()).toEqual([1, 2, 3, 4])
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

describe('a missing epoch row', () => {
  // Sequence 1 is the anchor for the whole epoch. Validating from the first row
  // that HAPPENS to remain declares the leftovers contiguous, and the corrupt
  // probe then hands them to a provider-history replacement that deletes every
  // live row — so the Orca-minted ones have to be set aside before that runs.
  it('rejects the whole surviving range rather than declaring it contiguous', async () => {
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
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(1)
    })

    const reopened = await open()
    expect(reopened.repair).toEqual({ malformedRows: 0, quarantinedRows: 3 })
    expect(recovered(reopened).map((row) => row.kind)).toEqual(['item', 'submission', 'dispatch'])

    // The epoch cannot be left row-less. An ordinary append would then take
    // sequence 1, replay would call that non-epoch row a clean timeline, and the
    // rows above would stay in quarantine with nothing left asking for them.
    expect(await liveSequences()).toEqual([1, 2])
    const anchor = await firstLiveRow()
    expect(anchor).toMatchObject({ kind: 'epoch', reason: 'unreconcilable_prefix' })
    expect(reopened.snapshot().items.some((entry) => entry.body.kind === 'status')).toBe(true)
  })

  // The repair epoch is a placeholder for history it could not rebuild. Left
  // clean it would end automatic recovery: the provider transcript is never
  // consulted again and the quarantined rows never come back.
  it('keeps asking for provider history until the epoch has content of its own', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('anchor'), { fence: 1 })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(1)
    })

    const repaired = await open()
    await repaired.close()
    expect(await loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: true })

    // A session that writes into the epoch owns it: its own rows are not a
    // repair placeholder, and a later import must not replace them.
    const writable = await open()
    await writable.appendItem(item(1), body('typed after the repair'), { fence: 1 })
    await writable.close()
    expect(await loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: false })
  })
})

describe('a second repair in the same epoch', () => {
  // A repair frees the sequence numbers it removed, and the live journal reuses
  // them. Keying the quarantine on `(session, epoch, seq)` alone therefore makes
  // the second repair overwrite what the first one preserved.
  it('keeps the earlier quarantined row when a later repair reuses its sequence', async () => {
    const first = await open()
    await first.appendItem(item(0), body('m0'), { fence: 1 })
    await first.appendItem(item(1), body('survives first fault'), { fence: 1 })
    await first.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(2)
    })

    const repaired = await open()
    expect(repaired.repair.quarantinedRows).toBe(1)
    // The live epoch is back to its anchor plus the repair disclosure, so these
    // reuse sequences 3 and 4 — and 3 is the sequence the first repair set aside.
    await repaired.appendItem(item(2), body('reused'), { fence: 1 })
    await repaired.appendItem(item(3), body('survives second fault'), { fence: 1 })
    await repaired.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(2)
    })

    const twice = await open()
    expect(twice.repair.quarantinedRows).toBe(2)
    // Both generations of sequence 3 are here: the surrogate key kept the first.
    expect(
      recovered(twice).map((row) =>
        row.kind === 'item' && row.body.kind === 'message' && row.body.blocks[0]?.type === 'text'
          ? row.body.blocks[0].text
          : null
      )
    ).toEqual(['survives first fault', 'reused', 'survives second fault'])
  })
})

describe('the admission charge', () => {
  // `journalTxnPhysicalCost` is page arithmetic over PHYSICAL bytes. SQLite's
  // `length()` on a TEXT value counts characters, so a multibyte suffix was
  // charged at up to a third of what it actually writes.
  it('charges physical UTF-8 bytes for a multibyte suffix, not characters', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('€'.repeat(100)), { fence: 1 })
    const epoch = journal.epoch
    await journal.close()

    await withJournalDatabase((db) => {
      const stored = db.prepare('SELECT row_json FROM journal_rows WHERE seq = 2').get() as {
        row_json: string
      }
      const physical = Buffer.byteLength(stored.row_json, 'utf8')
      expect(physical).toBeGreaterThan(stored.row_json.length)
      expect(countJournalRowSuffix(db, IDENTITY.sessionId, epoch, 2).rowJsonByteLengths).toEqual([
        physical
      ])
    })
  })

  it('refuses a multibyte lifecycle batch it cannot afford, and stays bounded where it fits', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('anchor'), { fence: 1 })
    await journal.appendLifecycleBatch({
      settlementId: 'multibyte',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'lifecycle-1' },
          body: { kind: 'status', text: '€'.repeat(120_000) }
        }
      ]
    })
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(2)
    })

    // The charge is recomputed from the row's real byte length, so this bound
    // cannot drift into passing because the counting primitive shrank.
    let charge = 0
    await withJournalDatabase((db) => {
      const stored = db.prepare('SELECT row_json FROM journal_rows WHERE seq = 3').get() as {
        row_json: string
      }
      const opened = openJournalDatabase(journalDatabaseFile(root))
      const pageSize = opened.pageSize
      opened.db.close()
      charge = journalTxnPhysicalCost([Buffer.byteLength(stored.row_json, 'utf8')], pageSize)
    })
    const measured = await journalDirectoryBytes(root)

    await expect(
      open({
        limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: measured + charge - 1 }
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    expect(await liveSequences()).toEqual([1, 3])

    // The same charge plus the documented cost of materializing a connection:
    // the copy now fits, and the repair's observed peak has to stay inside it.
    const bound = (await journalDirectoryBytes(root)) + charge + JOURNAL_MIN_SESSION_BYTES
    const peak = new JournalPeakSampler(root)
    const reopened = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: bound }
    })
    await peak.sample()
    expect(reopened.repair.quarantinedRows).toBe(1)
    expect(peak.peak).toBeLessThanOrEqual(bound)
  })
})
