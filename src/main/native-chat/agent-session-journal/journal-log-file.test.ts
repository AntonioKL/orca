import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendJournalRows, JOURNAL_SNAPSHOT_FILE, readJournalSnapshot } from './journal-log-file'
import type { JournalSnapshotFile } from './journal-log-file'
import type { JournalRow } from './journal-row-schema'
import { openAgentSessionJournal } from './journal-store'

type FakeDirectoryHandle = { sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

let openDirectoryHook: ((path: unknown, flags: unknown) => FakeDirectoryHandle | undefined) | null =
  null

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const fake = openDirectoryHook?.(args[0], args[1])
      return fake ?? actual.open(...args)
    }) as typeof actual.open
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-log-file-'))
  openDirectoryHook = null
})

afterEach(async () => {
  openDirectoryHook = null
  await rm(root, { recursive: true, force: true })
})

function validSnapshot(): JournalSnapshotFile {
  return {
    v: 1,
    epoch: 'epoch-A',
    compactedThrough: 2,
    highestFence: 1,
    items: [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] },
        sequence: 2,
        observedAt: 1_000
      }
    ],
    submissions: [],
    receipts: [],
    aliases: [],
    tombstones: [{ itemId: 'codex:thread-1:turn-1:2', revision: 3 }],
    tail: []
  }
}

async function writeSnapshot(snapshot: unknown): Promise<void> {
  await writeFile(join(root, JOURNAL_SNAPSHOT_FILE), JSON.stringify(snapshot), 'utf-8')
}

describe('readJournalSnapshot validation', () => {
  it('accepts a well-formed snapshot, with and without the tombstones collection', async () => {
    await writeSnapshot(validSnapshot())
    expect((await readJournalSnapshot(root)).status).toBe('valid')

    const { tombstones: _tombstones, ...withoutTombstones } = validSnapshot()
    await writeSnapshot(withoutTombstones)
    expect((await readJournalSnapshot(root)).status).toBe('valid')
  })

  it('classifies a JSON-valid non-array tombstones collection as invalid instead of valid', async () => {
    await writeSnapshot({ ...validSnapshot(), tombstones: {} })
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })

  it('rejects tombstone entries that would poison seeding', async () => {
    for (const tombstones of [
      [{ itemId: 42, revision: 1 }],
      [{ itemId: 'codex:thread-1:turn-1:1', revision: 'one' }],
      [{ itemId: 'codex:thread-1:turn-1:1', revision: Number.NaN }],
      ['codex:thread-1:turn-1:1']
    ]) {
      await writeSnapshot({ ...validSnapshot(), tombstones })
      expect((await readJournalSnapshot(root)).status).toBe('invalid')
    }
  })

  it('rejects items and counters that only look shallowly plausible', async () => {
    const missingSequence = validSnapshot()
    missingSequence.items = [
      { itemId: 'codex:thread-1:turn-1:1', revision: 1, body: { kind: 'status', text: 'x' } }
    ] as unknown as JournalSnapshotFile['items']
    await writeSnapshot(missingSequence)
    expect((await readJournalSnapshot(root)).status).toBe('invalid')

    await writeSnapshot({ ...validSnapshot(), compactedThrough: Number.NaN })
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })
})

describe('journal startup isolation from a malformed snapshot', () => {
  it('quarantines a JSON-valid malformed snapshot instead of throwing through open', async () => {
    await writeSnapshot({ ...validSnapshot(), tombstones: {} })

    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: root
    })

    // Degraded exactly like other corrupt snapshots: quarantined on disk, never
    // silently deleted, and the session does not adopt state it cannot trust.
    const entries = await readdir(root)
    expect(entries.some((entry) => entry.startsWith('quarantine-snapshot-'))).toBe(true)
    expect(entries.includes(JOURNAL_SNAPSHOT_FILE)).toBe(false)
    expect(journal.snapshot().items).toEqual([])
  })
})

describe('appendJournalRows directory fsync', () => {
  const ROW: JournalRow = {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    v: 1,
    epoch: 'epoch-A',
    seq: 1,
    fence: 0,
    ts: 1_000
  }

  function hookDirectoryOpen(sync: ReturnType<typeof vi.fn>): FakeDirectoryHandle {
    const fake: FakeDirectoryHandle = { sync, close: vi.fn(async () => undefined) }
    openDirectoryHook = (path, flags) => (path === root && flags === 'r' ? fake : undefined)
    return fake
  }

  it('closes the directory handle when directory fsync fails', async () => {
    const fake = hookDirectoryOpen(
      vi.fn(async () => {
        throw new Error('EINVAL: sync')
      })
    )

    // Tolerating unsupported directory fsync must not turn into a leak.
    await expect(appendJournalRows(root, [ROW])).resolves.toBeUndefined()
    expect(fake.sync).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('closes the directory handle when directory fsync succeeds', async () => {
    const fake = hookDirectoryOpen(vi.fn(async () => undefined))

    await expect(appendJournalRows(root, [ROW])).resolves.toBeUndefined()
    expect(fake.sync).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })
})
