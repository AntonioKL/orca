import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'

function sessionFor(send = vi.fn().mockResolvedValue(undefined)): ClaudeSession {
  return {
    connection: { send } as unknown as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    leafUuid: null,
    fence: 1,
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    options: new Map(),
    reportedOptions: {},
    capabilities: [],
    events: undefined,
    translator: null
  }
}

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('Claude structured dispatch image limits', () => {
  it('accepts a slash command from its result receipt when Claude omits the user replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: '/permissions' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    expect(
      resolveClaudeReplayWaiter(session, {
        type: 'result',
        subtype: 'success',
        session_id: 'provider-session',
        uuid: 'command-result-uuid'
      })
    ).toBe(false)

    await expect(dispatched).resolves.toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'command-result-uuid'
      }
    })
  })

  it('does not mistake a normal turn result for its missing user replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'hello' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    expect(
      resolveClaudeReplayWaiter(session, {
        type: 'result',
        session_id: 'provider-session',
        uuid: 'unrelated-result-uuid'
      })
    ).toBe(false)
    expect(session.dispatchWaiters).toHaveLength(1)
    expect(
      resolveClaudeReplayWaiter(session, {
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'provider-session',
        uuid: 'user-replay-uuid',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }]
        }
      })
    ).toBe(true)

    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'user-replay-uuid' }
    })
  })

  it('ignores a top-level tool-result user frame while waiting for a slash command replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: '/permissions' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'tool-result-uuid',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }]
      }
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'user-replay-uuid',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '/permissions' }]
      }
    })

    await expect(dispatched).resolves.toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'user-replay-uuid'
      }
    })
  })

  it('rejects more than twenty URL images before sending', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
    ).resolves.toEqual({ state: 'rejected', reason: 'Claude messages support at most 20 images' })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds twenty MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, Buffer.alloc(5 * 1024 * 1024))
          return path
        })
      )
      const session = sessionFor()
      const body = userMessage(paths.map((path) => ({ type: 'image-ref' as const, path })))

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude images must total no more than ${20 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image by actual bytes read beyond the per-image cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'oversized.png')
      await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude image must be a non-empty file no larger than ${5 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
