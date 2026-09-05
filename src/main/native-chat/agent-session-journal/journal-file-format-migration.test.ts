import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { journalDatabaseFile } from './journal-paths'
import type { JournalRow } from './journal-row-schema'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const USER_BODY = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'sent once' }]
}
const PROVIDER_ITEM_ID = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
})
const REMOVED_ITEM_ID = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
})

let root: string
let clock = 10_000
const journals = createTrackedJournalOpener()

function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: () => ++clock,
    mintEpoch: () => `sqlite-${clock}`,
    ...overrides
  })
}

function base(kind: JournalRow['kind'], seq: number) {
  return { kind, v: 1, epoch: 'legacy', seq, fence: 7, ts: 1_000 + seq }
}

function epoch(seq = 1): JournalRow {
  return {
    ...base('epoch', seq),
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: IDENTITY.providerHandle
  }
}

function item(seq: number, itemId: string, text: string): JournalRow {
  return {
    ...base('item', seq),
    kind: 'item',
    itemId,
    revision: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

async function writeRows(rows: readonly JournalRow[]): Promise<void> {
  await writeFile(
    join(root, 'log.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-file-migration-'))
  clock = 10_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('compacted file-format migration', () => {
  it('restores snapshot state plus the retained log suffix without losing idempotency', async () => {
    const submissionId = agentJournalSubmissionKey('client-1')
    const retained: JournalRow[] = [
      {
        ...base('dispatch', 3),
        kind: 'dispatch',
        clientMessageId: 'client-1',
        state: 'accepted',
        providerItemId: PROVIDER_ITEM_ID,
        reason: null
      },
      item(4, REMOVED_ITEM_ID, 'removed'),
      {
        ...base('tombstone', 5),
        kind: 'tombstone',
        itemId: REMOVED_ITEM_ID,
        revision: 2
      },
      {
        ...base('lifecycle-batch', 6),
        kind: 'lifecycle-batch',
        settlementId: 'settlement-1',
        mutations: [{ kind: 'item', itemId: submissionId, revision: 1, body: USER_BODY }]
      }
    ]
    const snapshot = {
      v: 1,
      epoch: 'legacy',
      compactedThrough: 6,
      highestFence: 7,
      items: [
        { itemId: submissionId, revision: 1, body: USER_BODY, sequence: 2, observedAt: 1_002 }
      ],
      submissions: [
        {
          clientMessageId: 'client-1',
          fence: 7,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'accepted',
          providerItemId: PROVIDER_ITEM_ID,
          reason: null,
          submittedAt: 1_002,
          resolvedAt: 1_003
        }
      ],
      receipts: [
        {
          clientMessageId: 'client-1',
          providerItemId: PROVIDER_ITEM_ID,
          epoch: 'legacy',
          sequence: 3,
          acceptedAt: 1_003
        }
      ],
      aliases: [{ providerItemId: PROVIDER_ITEM_ID, itemId: submissionId }],
      tombstones: [{ itemId: REMOVED_ITEM_ID, revision: 2 }],
      appliedSettlementIds: ['settlement-1'],
      tail: retained
    }
    await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot), 'utf8')
    await writeRows([...retained, item(7, 'legacy:codex:session-1:suffix', 'after compaction')])

    let journal = await open()

    expect(journal.snapshot().items.map((entry) => entry.body)).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        blocks: [{ type: 'text', text: 'after compaction' }]
      })
    )
    expect(journal.submissions()).toEqual([expect.objectContaining({ dispatchState: 'accepted' })])
    expect(journal.receiptFor('client-1')).toEqual(
      expect.objectContaining({ providerItemId: PROVIDER_ITEM_ID, acceptedAt: 1_003 })
    )
    expect(journal.canonicalItemId(PROVIDER_ITEM_ID)).toBe(submissionId)
    await journal.close()
    journal = await open()
    expect(journal.submissions()).toEqual([expect.objectContaining({ dispatchState: 'accepted' })])
    expect(journal.receiptFor('client-1')).toEqual(
      expect.objectContaining({ providerItemId: PROVIDER_ITEM_ID, acceptedAt: 1_003 })
    )
    expect(journal.canonicalItemId(PROVIDER_ITEM_ID)).toBe(submissionId)
    await expect(
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
        { kind: 'status', text: 'must stay removed' },
        { fence: 7 }
      )
    ).resolves.toBeDefined()
    expect(journal.snapshot().items.some((entry) => entry.itemId === REMOVED_ITEM_ID)).toBe(false)
    const beforeSettlement = journal.cursor()
    expect(
      await journal.appendLifecycleBatch({
        settlementId: 'settlement-1',
        mutations: [],
        fence: 7
      })
    ).toEqual(beforeSettlement)
    await expect(
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-2', ordinal: 0 },
        { kind: 'status', text: 'stale writer' },
        { fence: 6 }
      )
    ).rejects.toMatchObject({ code: 'journal_stale_fence' })
  })
})

describe('all-or-nothing migration', () => {
  it('refuses a sequence gap instead of importing a prefix', async () => {
    await writeRows([epoch(), item(3, 'legacy:codex:session-1:gap', 'after gap')])

    const journal = await open()

    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.body).toMatchObject({ kind: 'status' })
  })

  it('retries after a filesystem read failure instead of making it permanent', async () => {
    await mkdir(join(root, 'log.jsonl'))
    await expect(open()).rejects.toBeDefined()
    await rm(join(root, 'log.jsonl'), { recursive: true })
    await writeRows([epoch(), item(2, 'legacy:codex:session-1:retry', 'restored later')])

    const journal = await open()

    expect(journal.snapshot().items.some((entry) => entry.body.kind === 'message')).toBe(true)
  })

  it('retries a disclosed failure after the source is repaired', async () => {
    await writeFile(join(root, 'log.jsonl'), `${JSON.stringify(epoch())}\nnot-json\n`, 'utf8')
    const failed = await open()
    expect(failed.snapshot().items).toHaveLength(1)
    await failed.close()
    await writeRows([epoch(), item(2, 'legacy:codex:session-1:repaired', 'repaired')])

    const restored = await open()

    expect(restored.snapshot().items.some((entry) => entry.body.kind === 'message')).toBe(true)
    await restored.close()

    const db = new Database(journalDatabaseFile(root), { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS total FROM journal_file_imports').get()).toMatchObject({
        total: 1
      })
    } finally {
      db.close()
    }
  })

  it('does not rerecord an unchanged non-replayable remnant on every open', async () => {
    await writeFile(join(root, 'log.jsonl'), `${JSON.stringify(epoch())}\nnot-json\n`, 'utf8')
    const first = await open()
    const firstCursor = first.cursor()
    await first.close()

    const second = await open()
    expect(second.cursor()).toEqual(firstCursor)
    await second.close()

    const db = new Database(journalDatabaseFile(root), { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS total FROM journal_rows').get()).toMatchObject({
        total: 2
      })
      expect(db.prepare('SELECT count(*) AS total FROM journal_file_imports').get()).toMatchObject({
        total: 1
      })
    } finally {
      db.close()
    }
  })

  it('imports rows appended by a rollback-era build after a successful migration', async () => {
    await writeRows([epoch(), item(2, 'legacy:codex:session-1:first', 'first')])
    const migrated = await open()
    const migratedCursor = migrated.cursor()
    await migrated.close()
    await appendFile(
      join(root, 'log.jsonl'),
      `${JSON.stringify(item(3, 'legacy:codex:session-1:rollback', 'after rollback'))}\n`,
      'utf8'
    )

    const reupgraded = await open()

    expect(reupgraded.cursor()).not.toEqual(migratedCursor)
    expect(reupgraded.snapshot().items.map((entry) => entry.body)).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        blocks: [{ type: 'text', text: 'after rollback' }]
      })
    )
  })

  it('retries a repaired rollback source while retaining the last successful import', async () => {
    const firstItem = item(2, 'legacy:codex:session-1:first', 'first')
    await writeRows([epoch(), firstItem])
    const migrated = await open()
    await migrated.close()
    await appendFile(join(root, 'log.jsonl'), 'not-json\n', 'utf8')

    const unreadable = await open()
    expect(unreadable.snapshot().items.map((entry) => entry.body)).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        blocks: [{ type: 'text', text: 'first' }]
      })
    )
    await unreadable.close()
    await writeRows([
      epoch(),
      firstItem,
      item(3, 'legacy:codex:session-1:repaired', 'after repair')
    ])

    const repaired = await open()

    expect(repaired.snapshot().items.map((entry) => entry.body)).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        blocks: [{ type: 'text', text: 'after repair' }]
      })
    )
  })

  it('does not reparse or rewrite an unchanged successfully imported remnant', async () => {
    await writeRows([epoch(), item(2, 'legacy:codex:session-1:first', 'first')])
    const first = await open()
    const firstCursor = first.cursor()
    await first.close()

    const second = await open()
    expect(second.cursor()).toEqual(firstCursor)
    await second.close()

    const db = new Database(journalDatabaseFile(root), { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS total FROM journal_rows').get()).toMatchObject({
        total: 3
      })
      expect(db.prepare('SELECT count(*) AS total FROM journal_file_imports').get()).toMatchObject({
        total: 1
      })
    } finally {
      db.close()
    }
  })

  it('does not import the prefix before a future-version row', async () => {
    const future = { ...item(3, 'legacy:codex:session-1:future', 'future'), v: 99 }
    await writeFile(
      join(root, 'log.jsonl'),
      `${[epoch(), item(2, 'legacy:codex:session-1:prefix', 'prefix'), future]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`,
      'utf8'
    )

    const journal = await open()

    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.body).toMatchObject({ kind: 'status' })
  })

  it('leaves a future-version snapshot authoritative instead of importing its log tail', async () => {
    await writeFile(join(root, 'snapshot.json'), JSON.stringify({ v: 99 }), 'utf8')
    await writeRows([epoch(), item(2, 'legacy:codex:session-1:tail', 'tail')])

    const journal = await open()

    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.body).toMatchObject({ kind: 'status' })
  })

  it('discloses an internally inconsistent snapshot without failing startup', async () => {
    await writeFile(
      join(root, 'snapshot.json'),
      JSON.stringify({
        v: 1,
        epoch: 'legacy',
        compactedThrough: 1,
        highestFence: 0,
        items: [],
        submissions: [],
        receipts: [
          {
            clientMessageId: 'missing-submission',
            providerItemId: PROVIDER_ITEM_ID,
            epoch: 'legacy',
            sequence: 1,
            acceptedAt: 1
          }
        ],
        aliases: [],
        tombstones: [],
        tail: []
      }),
      'utf8'
    )

    const journal = await open()

    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.body).toMatchObject({ kind: 'status' })
  })

  it('does not truncate a valid log at the restored-item bound', async () => {
    const rows: JournalRow[] = [epoch()]
    for (let ordinal = 0; ordinal <= 20_000; ordinal += 1) {
      rows.push(item(ordinal + 2, `legacy:codex:session-1:${ordinal}`, `item ${ordinal}`))
    }
    await writeRows(rows)

    const journal = await open()

    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.body).toMatchObject({ kind: 'status' })
  })

  it('preserves an item whose legacy key cannot be inverted instead of dropping it', async () => {
    await writeRows([epoch(), item(2, '%not-a-key', 'opaque identity')])

    const journal = await open()

    expect(journal.snapshot().items).toEqual([
      expect.objectContaining({
        itemId: '%not-a-key',
        body: expect.objectContaining({ kind: 'message' })
      }),
      expect.objectContaining({ body: expect.objectContaining({ kind: 'status' }) })
    ])
  })
})
