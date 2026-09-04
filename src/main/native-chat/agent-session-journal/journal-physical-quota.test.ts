import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  JOURNAL_MIN_SESSION_BYTES,
  journalReclaimBandBytes,
  journalTxnPhysicalCost
} from './journal-database-space'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { JournalPeakSampler } from './journal-quota-test-peak'
import { createTrackedJournalOpener } from './journal-store-test-open'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function limitsWith(maxSessionBytes: number) {
  return { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-quota-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the substrate floor', () => {
  it('refuses a configured quota below the floor at open, naming it', async () => {
    await expect(
      journals.open({
        identity: IDENTITY,
        journalDir: root,
        limits: limitsWith(JOURNAL_MIN_SESSION_BYTES - 1)
      })
    ).rejects.toMatchObject({
      code: 'journal_bound_exceeded',
      message: expect.stringContaining(String(JOURNAL_MIN_SESSION_BYTES))
    })
  })

  it('opens at the floor, and a plain small append still succeeds', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      journalDir: root,
      limits: limitsWith(JOURNAL_MIN_SESSION_BYTES)
    })
    await expect(journal.appendItem(item(1), body('small'), { fence: 1 })).resolves.toMatchObject({
      revision: 1
    })
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(JOURNAL_MIN_SESSION_BYTES)
  })
})

describe('the physical bound is hard for every row kind the API admits', () => {
  it('refuses an ordinary item larger than any lifecycle batch, and stays writable', async () => {
    const limits = limitsWith(4 * 1024 * 1024)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    const peak = new JournalPeakSampler(root)
    await peak.sample()

    await expect(
      journal.appendItem(item(1), body('m'.repeat(10 * 1024 * 1024)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    await peak.sample()

    await expect(journal.appendItem(item(2), body('small'), { fence: 1 })).resolves.toMatchObject({
      revision: 1
    })
    await peak.sample()
    expect(peak.peak).toBeLessThanOrEqual(limits.maxSessionBytes)
  })

  it('admits the same oversized row where it fits, still under the bound at its peak', async () => {
    const limits = limitsWith(64 * 1024 * 1024)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    const peak = new JournalPeakSampler(root)

    await journal.appendItem(item(1), body('m'.repeat(10 * 1024 * 1024)), { fence: 1 })
    await peak.sample()
    expect(peak.peak).toBeLessThanOrEqual(limits.maxSessionBytes)
    expect(journal.snapshot().items).toHaveLength(1)
  })

  it('never admits a multi-row replacement past the bound', async () => {
    const limits = limitsWith(8 * 1024 * 1024)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    const peak = new JournalPeakSampler(root)
    const items = Array.from({ length: 6 }, (_, index) => ({
      identity: item(index + 10),
      body: body('r'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES))
    }))

    const replaced = await journal
      .replaceEpochItems('handle_forked', 1, items)
      .then(() => true)
      .catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'journal_bound_exceeded' })
        return false
      })
    await peak.sample()
    expect(peak.peak).toBeLessThanOrEqual(limits.maxSessionBytes)
    if (replaced) {
      expect(journal.snapshot().items).toHaveLength(items.length)
    }
  })

  it('refuses the candidate whose projection crosses the bound, and not the one below it', async () => {
    const limits = limitsWith(4 * 1024 * 1024)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    const measured = await journalDirectoryBytes(root)
    const headroom = limits.maxSessionBytes - measured - journalReclaimBandBytes(measured, 4096)
    const admissible = 'a'.repeat(payloadFittingIn(headroom))

    await expect(journal.appendItem(item(1), body(admissible), { fence: 1 })).resolves.toBeDefined()
    await expect(
      journal.appendItem(item(2), body('b'.repeat(4 * 1024 * 1024)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(limits.maxSessionBytes)
  })

  // Why: the file substrate's arithmetic also charged too MUCH — a transaction
  // that reuses already-allocated pages grows the directory by zero.
  it('does not refuse a transaction that reuses pages a prior epoch freed', async () => {
    const limits = limitsWith(4 * 1024 * 1024)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    for (let ordinal = 0; ordinal < 40; ordinal += 1) {
      await journal.appendItem(item(ordinal), body('f'.repeat(20_000)), { fence: 1 })
    }
    const grown = await journalDirectoryBytes(root)
    await journal.rollEpoch('handle_forked', 1)
    const rolled = await journalDirectoryBytes(root)
    expect(rolled).toBeLessThan(grown)

    for (let ordinal = 100; ordinal < 140; ordinal += 1) {
      await expect(
        journal.appendItem(item(ordinal), body('g'.repeat(20_000)), { fence: 1 })
      ).resolves.toBeDefined()
    }
  })

  it('counts a durable-write temp left by a crash toward the measurement', async () => {
    const limits = limitsWith(1024 * 1024)
    const journal = await journals.open({ identity: IDENTITY, journalDir: root, limits })
    await journal.appendItem(item(1), body('old'), { fence: 1 })
    await writeFile(join(root, 'blobs.crashed-write.tmp'), 'x'.repeat(900_000), 'utf8')
    const epoch = journal.epoch

    await expect(
      journal.replaceEpochItems('handle_forked', 2, [{ identity: item(2), body: body('new') }])
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    expect(journal.epoch).toBe(epoch)
  })
})

/** Largest row body whose charged transaction still fits in `headroom`. */
function payloadFittingIn(headroom: number): number {
  let bytes = 1
  while (journalTxnPhysicalCost([bytes * 2], 4096) < headroom) {
    bytes *= 2
  }
  return bytes
}
