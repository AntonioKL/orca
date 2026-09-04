// The two values SQLite stores as KEYS, and why they have to be bounded.
//
// `session_id` and `epoch` are written into `journal_rows`, into the implicit
// index its composite primary key creates, and again into `journal_sessions` —
// and neither appears in `row_json`. The physical charge is computed from
// `row_json` plus a fixed page allowance, so an unbounded key is unbounded
// payload the charge cannot see. Before the bound, a 2 MiB session id under a
// 1 MiB quota opened successfully and the directory was already over the bound.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { journalTxnPhysicalCost } from './journal-database-space'
import {
  assertJournalKeyBytes,
  JOURNAL_MAX_EPOCH_BYTES,
  JOURNAL_MAX_SESSION_ID_BYTES,
  JOURNAL_ROW_KEY_BYTES
} from './journal-key-bounds'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-keys-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the journal boundary', () => {
  // The exact reproduction from the review: this used to open successfully.
  it('refuses a session id larger than the charge assumes', async () => {
    await expect(
      journals.open({
        identity: { ...IDENTITY, sessionId: 'x'.repeat(2 * 1024 * 1024) },
        journalDir: root,
        limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 1024 * 1024 }
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    expect(await journalDirectoryBytes(root)).toBe(0)
  })

  it('refuses an oversized minted epoch, which no other bound covers', async () => {
    await expect(
      journals.open({
        identity: IDENTITY,
        journalDir: root,
        mintEpoch: () => 'e'.repeat(JOURNAL_MAX_EPOCH_BYTES + 1)
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('admits both keys at exactly their bound', async () => {
    const journal = await journals.open({
      identity: { ...IDENTITY, sessionId: 's'.repeat(JOURNAL_MAX_SESSION_ID_BYTES) },
      journalDir: root,
      mintEpoch: () => 'e'.repeat(JOURNAL_MAX_EPOCH_BYTES)
    })
    expect(journal.epoch).toHaveLength(JOURNAL_MAX_EPOCH_BYTES)
  })

  it('counts BYTES, not characters, so a multi-byte id cannot slip past', () => {
    // Each '€' is three UTF-8 bytes; the length in characters is well under.
    const id = '€'.repeat(JOURNAL_MAX_SESSION_ID_BYTES - 1)
    expect(id.length).toBeLessThan(JOURNAL_MAX_SESSION_ID_BYTES)
    expect(() => assertJournalKeyBytes({ sessionId: id })).toThrow(
      expect.objectContaining({ code: 'journal_bound_exceeded' })
    )
  })
})

describe('the charge', () => {
  it('covers both key copies of every admitted row', () => {
    expect(JOURNAL_ROW_KEY_BYTES).toBe(2 * (JOURNAL_MAX_SESSION_ID_BYTES + JOURNAL_MAX_EPOCH_BYTES))
    // A row whose body is empty still costs the key copies plus the projection,
    // which is exactly the payload the pre-fix charge could not see.
    expect(journalTxnPhysicalCost([0], 4096)).toBeGreaterThan(journalTxnPhysicalCost([], 4096))
  })
})
