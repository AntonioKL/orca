// An abandoned file-format journal explains itself.
//
// The SQLite move shipped no importer, so a session whose history is a
// `log.jsonl` founds a fresh empty journal beside it and looks exactly like a
// chat created seconds ago. Every case here asserts the two halves that make it
// distinguishable: the empty session carries a status row naming the transcript
// still on disk, AND a session with a timeline of its own is never appended to.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID } from './journal-file-format-remnant'
import { loadJournal } from './journal-open'
import type { AgentSessionJournal } from './journal-store'
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

/** The pre-SQLite journal, in the one shape a real one has: a row per line. */
function writeFileFormatJournal(name = 'log.jsonl'): Promise<void> {
  return writeFile(
    join(root, name),
    `${JSON.stringify({
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      v: 1,
      epoch: 'file-era-epoch',
      seq: 1,
      fence: 0,
      ts: 1
    })}\n`,
    'utf8'
  )
}

/** An item row in the pre-SQLite shape: the same `JournalRow` the table stores. */
function itemLine(input: {
  ordinal: number
  text: string
  epoch?: string
  seq: number
  revision?: number
}): string {
  return JSON.stringify({
    kind: 'item',
    itemId: agentJournalItemKey(item(input.ordinal)),
    revision: input.revision ?? 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: input.text }] },
    v: 1,
    epoch: input.epoch ?? 'file-era-epoch',
    seq: input.seq,
    fence: 0,
    ts: 1_000 + input.seq
  })
}

function epochLine(epoch: string, seq: number): string {
  return JSON.stringify({
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    v: 1,
    epoch,
    seq,
    fence: 0,
    ts: 1_000 + seq
  })
}

function writeFileFormatLog(lines: readonly string[]): Promise<void> {
  return writeFile(join(root, 'log.jsonl'), `${lines.join('\n')}\n`, 'utf8')
}

function transcriptText(journal: AgentSessionJournal): string[] {
  return journal
    .snapshot()
    .items.filter((entry) => entry.itemId !== JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID)
    .map((entry) => {
      const block = entry.body.kind === 'message' ? entry.body.blocks[0] : undefined
      return block?.type === 'text' ? block.text : ''
    })
}

function disclosureText(journal: AgentSessionJournal): string | null {
  const disclosed = journal
    .snapshot()
    .items.find((entry) => entry.itemId === JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID)
  if (!disclosed) {
    return null
  }
  return disclosed.body.kind === 'status' ? disclosed.body.text : null
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-file-format-remnant-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a session founded beside an abandoned file-format journal', () => {
  it('names the transcript still on disk', async () => {
    await writeFileFormatJournal()

    const journal = await open()

    expect(disclosureText(journal)).toContain(join(root, 'log.jsonl'))
    expect(disclosureText(journal)).toContain('older format')
  })

  it('discloses a compacted journal that kept its history in the snapshot', async () => {
    await writeFileFormatJournal('snapshot.json')

    const journal = await open()

    expect(disclosureText(journal)).toContain(join(root, 'snapshot.json'))
  })

  it('says nothing to a chat that is genuinely new', async () => {
    const journal = await open()

    expect(disclosureText(journal)).toBeNull()
    expect(journal.snapshot().items).toEqual([])
  })

  it('restates the one row rather than adding another on every open', async () => {
    await writeFileFormatJournal()
    const first = await open()
    await first.close()
    const second = await open()
    await second.close()

    const third = await open()
    expect(
      third
        .snapshot()
        .items.filter((entry) => entry.itemId === JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID)
    ).toHaveLength(1)
  })

  // A row nothing projects is a row nobody reads: the disclosure only works if it
  // survives the projection the chat renders from.
  it('renders in the transcript as a system line', async () => {
    await writeFileFormatJournal()

    const journal = await open()

    const messages = projectStructuredItemsToNativeChat(journal.snapshot().items)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining(join(root, 'log.jsonl')) }
    ])
  })

  // The remnant is not corruption: replay must not start asking provider history
  // to rebuild an epoch whose only content is this disclosure.
  it('replays as a clean timeline', async () => {
    await writeFileFormatJournal()
    const journal = await open()
    await journal.close()

    const loaded = loadJournal(root, IDENTITY.sessionId)
    expect(loaded?.corrupt).toBe(false)
    expect(loaded?.readOnly).toBe(false)
  })
})

// The user who opened an old chat before this disclosure existed already has an
// empty `journal.db` sitting beside the remnant, and nothing would ever tell them.
describe('a journal already re-founded empty beside the remnant', () => {
  it('discloses on the next open', async () => {
    const founded = await open()
    await founded.close()
    await writeFileFormatJournal()

    const reopened = await open()

    expect(disclosureText(reopened)).toContain(join(root, 'log.jsonl'))
  })

  it('leaves a session that has since been written into alone', async () => {
    const founded = await open()
    await founded.appendItem(item(0), body('history of its own'), { fence: 1 })
    await founded.close()
    await writeFileFormatJournal()

    const reopened = await open()

    expect(disclosureText(reopened)).toBeNull()
    expect(reopened.snapshot().items).toHaveLength(1)
  })
})

// The rows never changed shape — only the substrate did — so the old log folds
// through the same reducer the table replays with.
describe('replaying a pre-SQLite log.jsonl', () => {
  it('brings the conversation back', async () => {
    await writeFileFormatLog([
      epochLine('file-era-epoch', 1),
      itemLine({ ordinal: 0, text: 'first message', seq: 2 }),
      itemLine({ ordinal: 1, text: 'second message', seq: 3 })
    ])

    const journal = await open()

    expect(transcriptText(journal)).toEqual(['first message', 'second message'])
    expect(disclosureText(journal)).toContain('Restored 2 items')
  })

  it('keeps only the last epoch, the way replay scopes one', async () => {
    await writeFileFormatLog([
      epochLine('superseded', 1),
      itemLine({ ordinal: 0, text: 'from the abandoned epoch', epoch: 'superseded', seq: 2 }),
      epochLine('live', 3),
      itemLine({ ordinal: 1, text: 'from the live epoch', epoch: 'live', seq: 4 })
    ])

    const journal = await open()

    expect(transcriptText(journal)).toEqual(['from the live epoch'])
  })

  it('takes the highest revision of an item, not the first', async () => {
    await writeFileFormatLog([
      epochLine('file-era-epoch', 1),
      itemLine({ ordinal: 0, text: 'draft', seq: 2, revision: 1 }),
      itemLine({ ordinal: 0, text: 'final', seq: 3, revision: 2 })
    ])

    const journal = await open()

    expect(transcriptText(journal)).toEqual(['final'])
  })

  it('does not commit a partial prefix when a row is unreadable', async () => {
    await writeFileFormatLog([
      epochLine('file-era-epoch', 1),
      itemLine({ ordinal: 0, text: 'readable', seq: 2 }),
      '}{ not a row',
      itemLine({ ordinal: 1, text: 'after the fault', seq: 4 })
    ])

    const journal = await open()

    expect(transcriptText(journal)).toEqual([])
    expect(disclosureText(journal)).toContain('could not read')
  })

  it('replays once — a reopen neither re-imports nor doubles the row', async () => {
    await writeFileFormatLog([
      epochLine('file-era-epoch', 1),
      itemLine({ ordinal: 0, text: 'only once', seq: 2 })
    ])
    const first = await open()
    await first.close()

    const reopened = await open()

    expect(transcriptText(reopened)).toEqual(['only once'])
    expect(
      reopened
        .snapshot()
        .items.filter((entry) => entry.itemId === JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_ITEM_ID)
    ).toHaveLength(1)
  })

  it('discloses rather than restores a compacted snapshot, which holds state not rows', async () => {
    await writeFileFormatJournal('snapshot.json')

    const journal = await open()

    expect(transcriptText(journal)).toEqual([])
    expect(disclosureText(journal)).toContain('could not read')
  })
})
