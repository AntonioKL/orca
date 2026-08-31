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
    events: undefined,
    translator: null
  }
}

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('Claude structured text dispatch', () => {
  it('accepts a slash command when Claude provides a result uuid', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: '/permissions' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session',
      uuid: 'command-result-uuid'
    })

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

    resolveClaudeReplayWaiter(session, {
      type: 'result',
      session_id: 'provider-session',
      uuid: 'unrelated-result-uuid'
    })
    expect(session.dispatchWaiters).toHaveLength(1)
    resolveClaudeReplayWaiter(session, {
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'user-replay-uuid'
    })

    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'user-replay-uuid' }
    })
  })

  it('sends a local attachment as a base64 image Claude accepts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'shot.png')
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      await writeFile(path, bytes)
      const session = sessionFor()
      const body = userMessage([
        { type: 'text', text: 'look' },
        { type: 'image-ref', path }
      ])

      const dispatched = dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 100)
      await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
      resolveClaudeReplayWaiter(session, {
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'provider-session',
        uuid: 'replayed-uuid'
      })

      await expect(dispatched).resolves.toEqual({
        state: 'accepted',
        providerIdentity: {
          provider: 'claude',
          sessionId: 'provider-session',
          uuid: 'replayed-uuid'
        }
      })
      expect(session.connection.send).toHaveBeenCalledWith({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: bytes.toString('base64')
              }
            }
          ]
        },
        parent_tool_use_id: null,
        session_id: 'provider-session'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a message carrying more images than one turn may inline', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
    ).resolves.toEqual({
      state: 'rejected',
      reason: 'Claude accepts at most 20 images per message; this one has 21'
    })
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
        reason: 'Claude accepts up to 20971520 bytes of images per message'
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
        reason: `Claude accepts images up to 5242880 bytes; ${path} is 5242881`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
