// Read restore decides whether a session comes back at all.
//
// A journal still in the pre-SQLite format has no `journal.db`, so the probe
// that opens one reports nothing. Treating that as "no session" is what dropped
// these chats: unpublished sessions are also what prunes their tabs out of the
// saved workspace, so the tab is gone before anything can replay the history.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

const SESSION_ID = 'codex_read_restore_fixture'
const WORKSPACE_ID = 'repo-1::/tmp/workspace'

const RECORD = {
  schemaVersion: 2,
  sessionId: SESSION_ID,
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: WORKSPACE_ID,
    workspaceKind: 'git-worktree'
  },
  provider: 'codex',
  providerHandleChain: [
    {
      linkId: 'codex-1-thread-1',
      handle: { provider: 'codex', threadId: 'thread-1' },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    }
  ],
  accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
  createdAt: 1,
  updatedAt: 2,
  lease: { sessionId: SESSION_ID, runtimeKind: 'native', runtimeFence: 1 }
} as unknown as AgentSessionRecord

const store = {
  getRecord: (sessionId: string) => (sessionId === SESSION_ID ? RECORD : null)
} as unknown as AgentSessionRecordStore

let journalRoot: string
const opened: { close: () => Promise<void> }[] = []

function journalDir(): string {
  return journalDirectoryFor(journalRoot, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID })
}

async function writeRemnant(): Promise<void> {
  const dir = journalDir()
  await rm(dir, { recursive: true, force: true })
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
  const itemId = agentJournalItemKey({
    provider: 'codex',
    threadId: 'thread-1',
    turnId: 'turn-1',
    ordinal: 0
  })
  const lines = [
    JSON.stringify({
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      v: 1,
      epoch: 'file-era',
      seq: 1,
      fence: 0,
      ts: 1
    }),
    JSON.stringify({
      kind: 'item',
      itemId,
      revision: 1,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'from the old format' }]
      },
      v: 1,
      epoch: 'file-era',
      seq: 2,
      fence: 0,
      ts: 2
    })
  ]
  await writeFile(join(dir, 'log.jsonl'), `${lines.join('\n')}\n`, 'utf8')
}

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-read-restore-'))
})

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
  await rm(journalRoot, { recursive: true, force: true })
})

describe('restoring a session whose journal is still the pre-SQLite format', () => {
  it('publishes it, with the history replayed', async () => {
    await writeRemnant()

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).not.toBeNull()
    opened.push(restored!.journal)
    const texts = restored!.journal.snapshot().items.map((entry) => {
      const block = entry.body.kind === 'message' ? entry.body.blocks[0] : undefined
      return block?.type === 'text' ? block.text : ''
    })
    expect(texts).toContain('from the old format')
    // Read restore opens the journal and nothing else — no provider is spawned to
    // put the history back on screen.
    expect(restored!.hasProviderChild).toBe(false)
  })

  it('still drops a session with neither a journal nor a remnant', async () => {
    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).toBeNull()
  })
})
