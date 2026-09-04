// Blob retention, and the budget-pressure shed that replaced compaction.
//
// No row is ever shed inside an epoch, so the only bytes an append under
// pressure can free are unreferenced BLOB bytes. The protected set is a UNION —
// live reducer digests AND the candidate row's own digests — because content
// addressing never rewrites a digest already on disk, so pruning on live state
// alone deletes the blob the append is about to cite.

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
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  digestPayload
} from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const MAX_BYTES = 4 * 1024 * 1024
const BLOB_LIMITS = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 32 }

let root: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function toolBody(payload: string): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name: 'command',
    input: {},
    state: 'completed',
    output: boundPayload(payload, BLOB_LIMITS)
  }
}

function openJournal(maxSessionBytes = MAX_BYTES): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes }
  })
}

/** A blob nothing references, sized so the next append is under pressure. */
async function writeUnreferencedBlob(bytes: number): Promise<string> {
  const payload = 'u'.repeat(bytes)
  const digest = digestPayload(payload)
  await putJournalBlob(root, digest, payload)
  return digest
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-blob-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('blob retention', () => {
  it('prunes blobs no live row references and keeps the ones that survive', async () => {
    const journal = await openJournal()
    const kept = 'k'.repeat(64)
    const dropped = 'd'.repeat(64)
    await putJournalBlob(root, digestPayload(kept), kept)
    await putJournalBlob(root, digestPayload(dropped), dropped)
    await journal.appendItem(item(0), toolBody(kept), { fence: 1 })

    await journal.replaceEpochItems('handle_forked', 1, [
      {
        identity: item(0),
        body: toolBody(kept),
        blobs: [{ digest: digestPayload(kept), payload: kept }]
      }
    ])

    expect(await readJournalBlob(root, digestPayload(kept))).toBe(kept)
    expect(await readJournalBlob(root, digestPayload(dropped))).toBeNull()
  })

  it('refuses a blob name that is not a bare digest, on either slash', async () => {
    // A corrupt or crafted row must not steer a read or a write out of the store.
    for (const name of ['../../escape', '..\\..\\escape', 'nested/name', 'NOTHEX']) {
      expect(await readJournalBlob(root, name)).toBeNull()
      await expect(putJournalBlob(root, name, 'payload')).rejects.toThrow('sha256 digest')
    }
  })

  it('preserves the highest fence across an epoch roll and a reopen', async () => {
    const journal = await openJournal()
    await journal.appendItem(item(0), body('a'), { fence: 7 })
    await journal.rollEpoch('handle_forked', 7)
    await journal.close()

    const reopened = await openJournal()
    await expect(reopened.appendItem(item(1), body('stale'), { fence: 6 })).rejects.toMatchObject({
      code: 'journal_stale_fence'
    })
  })

  it('preserves tombstones across a reopen', async () => {
    const journal = await openJournal()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.appendTombstone(item(0), { fence: 1 })
    await journal.close()

    const reopened = await openJournal()
    await reopened.appendItem(item(0), body('stale'), { fence: 1 })
    expect(reopened.snapshot().items).toHaveLength(0)
  })
})

describe('budget-pressure blob pruning', () => {
  it('admits an append after shedding unreferenced blob bytes', async () => {
    const journal = await openJournal()
    const orphan = await writeUnreferencedBlob(4_000_000)
    expect(await journalDirectoryBytes(root)).toBeGreaterThan(3 * 1024 * 1024)

    await expect(
      journal.appendItem(item(1), body('under pressure'), { fence: 1 })
    ).resolves.toBeDefined()
    expect(await readJournalBlob(root, orphan)).toBeNull()
  })

  it('still refuses an append the shed cannot rescue', async () => {
    const journal = await openJournal()
    await expect(
      journal.appendItem(item(1), body('x'.repeat(8 * 1024 * 1024)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  // The regression: a digest that left LIVE state but is still on disk and is
  // cited again by the very append that triggers the prune.
  it('keeps a stale on-disk digest the triggering append reuses', async () => {
    const journal = await openJournal()
    const payload = 'r'.repeat(4096)
    const digest = digestPayload(payload)
    await journal.appendItemWithBlobs(item(1), toolBody(payload), [{ digest, payload }], {
      fence: 1
    })
    // A higher revision wins, so `digest` leaves live reducer state while its
    // file stays on disk.
    await journal.appendItem(item(1), body('superseded'), { fence: 1 })
    const orphan = await writeUnreferencedBlob(4_000_000)

    await expect(
      journal.appendItemWithBlobs(item(2), toolBody(payload), [{ digest, payload }], { fence: 1 })
    ).resolves.toBeDefined()

    // The prune actually fired, so the case cannot pass by doing nothing.
    expect(await readJournalBlob(root, orphan)).toBeNull()
    await journal.close()
    const reopened = await openJournal()
    expect(await readJournalBlob(root, digest)).toBe(payload)
    const rendered = reopened.snapshot().items.find((entry) => entry.itemId.includes(':2'))
    expect(rendered?.body).toMatchObject({ kind: 'tool-call', output: { digest } })
  })

  // The half `blobDigestsInBody` covers and the `blobs` argument does not.
  it('keeps a digest cited only by a nested lifecycle-batch mutation', async () => {
    const journal = await openJournal()
    const payload = 's'.repeat(4096)
    const digest = digestPayload(payload)
    await journal.appendItemWithBlobs(item(1), toolBody(payload), [{ digest, payload }], {
      fence: 1
    })
    await journal.appendItem(item(1), body('superseded'), { fence: 1 })
    const orphan = await writeUnreferencedBlob(4_000_000)

    await journal.appendLifecycleBatch({
      settlementId: 'settle:reuse',
      fence: 1,
      mutations: [{ kind: 'item', identity: item(3), body: toolBody(payload) }]
    })

    expect(await readJournalBlob(root, orphan)).toBeNull()
    await journal.close()
    await openJournal()
    expect(await readJournalBlob(root, digest)).toBe(payload)
    expect(await readdir(join(root, 'blobs'))).toEqual([digest])
  })
})
