// The escape from the row-bytes hard stop.
//
// Deleting rows moves pages to the freelist and leaves the file exactly as
// large as it was, so `replaceEpochItems` only returns bytes if reclamation is
// wired in. Without it the escape is a lie the next reader has to disprove.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type * as JournalDatabaseSpace from './journal-database-space'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { JournalPeakSampler } from './journal-quota-test-peak'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const reclaim = vi.hoisted(() => ({ disabled: false }))

vi.mock('./journal-database-space', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalDatabaseSpace>()
  return {
    ...actual,
    reclaimJournalDatabaseSpace: async (
      input: Parameters<typeof actual.reclaimJournalDatabaseSpace>[0]
    ) => {
      if (reclaim.disabled) {
        return
      }
      await actual.reclaimJournalDatabaseSpace(input)
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

const MAX_BYTES = 8 * 1024 * 1024

let root: string
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

/** Rows alone — no blobs — until the bound refuses one. */
async function fillWithRows(journal: AgentSessionJournal, peak: JournalPeakSampler): Promise<void> {
  for (let ordinal = 1; ordinal < 4000; ordinal += 1) {
    const landed = await journal
      .appendItem(item(ordinal), body('f'.repeat(40_000)), { fence: 1 })
      .then(() => true)
      .catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'journal_bound_exceeded' })
        return false
      })
    await peak.sample()
    if (!landed) {
      return
    }
  }
  throw new Error('the row bound was never reached')
}

beforeEach(async () => {
  reclaim.disabled = false
  root = await mkdtemp(join(tmpdir(), 'orca-journal-escape-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('replaceEpochItems as the escape from the row bound', () => {
  it('returns bytes to the filesystem and admits the next append', async () => {
    const journal = await openJournal()
    const peak = new JournalPeakSampler(root)
    await fillWithRows(journal, peak)
    const atBound = await journalDirectoryBytes(root)

    await journal.replaceEpochItems('handle_forked', 1, [
      { identity: item(1), body: body('republished') }
    ])
    await peak.sample()
    const afterEscape = await journalDirectoryBytes(root)

    expect(afterEscape).toBeLessThan(atBound / 2)
    await expect(journal.appendItem(item(2), body('after'), { fence: 1 })).resolves.toBeDefined()
    expect(peak.peak).toBeLessThanOrEqual(MAX_BYTES)

    await journal.close()
    const reopened = await openJournal()
    expect(
      reopened
        .snapshot()
        .items.map((entry) => (entry.body as { blocks: { text: string }[] }).blocks[0]?.text)
    ).toContain('republished')
  }, 180_000)

  // Without this control the case passes on an implementation that never
  // reclaims: the rows go, the file does not shrink, and the session stays stuck.
  it('does not escape when reclamation is stubbed out', async () => {
    const journal = await openJournal()
    const peak = new JournalPeakSampler(root)
    await fillWithRows(journal, peak)
    const atBound = await journalDirectoryBytes(root)

    reclaim.disabled = true
    await journal.replaceEpochItems('handle_forked', 1, [
      { identity: item(1), body: body('republished') }
    ])

    expect(await journalDirectoryBytes(root)).toBeGreaterThan(atBound / 2)
    await expect(
      journal.appendItem(item(2), body('f'.repeat(40_000)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  }, 180_000)
})
