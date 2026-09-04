// Republishing an epoch is ONE transaction, and blobs are the half a ROLLBACK
// does not cover.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { putJournalBlob, readJournalBlob } from './journal-blob-store'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import type { JournalLoad } from './journal-open'
import { journalDatabaseFile } from './journal-paths'
import { boundPayload, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { readJournalEpochRows, readJournalSessionEpoch } from './journal-row-table'
import { createTrackedJournalOpener } from './journal-store-test-open'
import { JournalAppendBudget } from './journal-write-guards'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
let database: OpenJournalDatabase
const journals = createTrackedJournalOpener()

function now(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function toolBody(output: ReturnType<typeof boundPayload>): AgentJournalItemBody {
  return { kind: 'tool-call', name: 'shell', input: {}, state: 'completed', output }
}

function replace(input: {
  items: Parameters<typeof replaceJournalEpoch>[0]['items']
  maxSessionBytes?: number
  onPublished?: (loaded: JournalLoad) => void
}): Promise<void> {
  return replaceJournalEpoch({
    db: database.db,
    pageSize: database.pageSize,
    journalDir: root,
    dbPath: journalDatabaseFile(root),
    identity: IDENTITY,
    reason: 'legacy_import',
    fence: 1,
    items: input.items,
    budget: new JournalAppendBudget(IDENTITY.sessionId, {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      ...(input.maxSessionBytes === undefined ? {} : { maxSessionBytes: input.maxSessionBytes })
    }),
    now,
    mintEpoch: () => `epoch-${clock}`,
    onPublished: input.onPublished ?? (() => undefined)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
  clock = 1_000
  database = openJournalDatabase(journalDatabaseFile(root))
})

afterEach(async () => {
  try {
    database.db.close()
  } catch {
    // Already closed by the case.
  }
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('journal epoch replacement', () => {
  it('publishes one observable replacement and prunes stale blobs afterward', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    const stalePayload = 'stale'.repeat(1_000)
    const retainedPayload = 'retained'.repeat(1_000)
    const stale = boundPayload(stalePayload, limits)
    const retained = boundPayload(retainedPayload, limits)
    await putJournalBlob(root, stale.digest, stalePayload)
    const published: JournalLoad[] = []

    await replace({
      items: [
        {
          identity: item(1),
          body: toolBody(retained),
          blobs: [{ digest: retained.digest, payload: retainedPayload }]
        }
      ],
      onPublished: (loaded) => published.push(loaded)
    })

    expect(published).toHaveLength(1)
    expect(await readJournalBlob(root, retained.digest)).toBe(retainedPayload)
    expect(await readJournalBlob(root, stale.digest)).toBeNull()
    expect(await readdir(join(root, 'blobs'))).toEqual([retained.digest])
    const epoch = readJournalSessionEpoch(database.db, IDENTITY.sessionId)
    expect(epoch).toBe(published[0]?.state.epoch)
    expect(readJournalEpochRows(database.db, IDENTITY.sessionId, epoch ?? '')).toHaveLength(2)
  })

  it('discards every superseded row in the same transaction', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendItem(item(1), { kind: 'status', text: 'old' }, { fence: 1 })
    await journal.appendItem(item(2), { kind: 'status', text: 'older' }, { fence: 1 })
    const before = journal.epoch

    await journal.replaceEpochItems('legacy_import', 1, [
      { identity: item(9), body: { kind: 'status', text: 'republished' } }
    ])

    expect(journal.epoch).not.toBe(before)
    expect(readJournalEpochRows(database.db, IDENTITY.sessionId, before)).toHaveLength(0)
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([
      { kind: 'status', text: 'republished' }
    ])
  })

  it('rolls back and cleans its orphan blobs when the transaction cannot be admitted', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    const keptPayload = 'kept'.repeat(1_000)
    const kept = boundPayload(keptPayload, limits)
    await putJournalBlob(root, kept.digest, keptPayload)
    const oversizedPayload = 'o'.repeat(4 * 1024 * 1024)
    const oversized = boundPayload(oversizedPayload, limits)
    const published: JournalLoad[] = []
    const before = await journalDirectoryBytes(root)

    await expect(
      replace({
        maxSessionBytes: 1024 * 1024,
        items: [
          {
            identity: item(1),
            body: toolBody(oversized),
            blobs: [{ digest: oversized.digest, payload: oversizedPayload }]
          }
        ],
        onPublished: (loaded) => published.push(loaded)
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(published).toHaveLength(0)
    expect(await readJournalBlob(root, oversized.digest)).toBeNull()
    // The blob that was already there is untouched — the rollback returns the
    // directory to its pre-replacement state and no further.
    expect(await readJournalBlob(root, kept.digest)).toBe(keptPayload)
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(before)
  })

  it('charges the whole multi-row transaction, not one row at a time', async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      identity: item(index),
      body: { kind: 'status' as const, text: 'x'.repeat(30_000) }
    }))

    await expect(replace({ maxSessionBytes: 1024 * 1024, items })).rejects.toMatchObject({
      code: 'journal_bound_exceeded'
    })
    expect(readJournalSessionEpoch(database.db, IDENTITY.sessionId)).toBeNull()
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(1024 * 1024)
  })
})
