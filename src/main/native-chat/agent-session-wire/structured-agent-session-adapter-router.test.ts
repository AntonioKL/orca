import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { adapterSupportsCreate } from './structured-agent-session-provider-support'

const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder'
}

function identity(agent: 'claude' | 'codex', sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent,
    providerHandle:
      agent === 'claude'
        ? { kind: 'claude', sessionId: 'provider-1', leafUuid: null }
        : { kind: 'codex', threadId: 'thread-1' }
  }
}

function fakeAdapter(agent: 'claude' | 'codex') {
  const dispatch = vi.fn(async () => ({ state: 'rejected' as const, reason: agent }))
  const closeSession = vi.fn(async () => true)
  const releaseAcquisition = vi.fn(async () => true)
  const adapter = {
    supportsCreate: vi.fn(
      (_location: AgentSessionExecutionLocation, candidate: string) => candidate === agent
    ),
    acquire: vi.fn(async () => ({
      process: {
        hostId: 'local',
        pid: agent === 'claude' ? 101 : 102,
        processStartTimeMs: 1,
        spawnToken: 'spawn'
      },
      link:
        agent === 'claude'
          ? {
              linkId: 'claude-link',
              handle: { provider: 'claude' as const, sessionId: 'provider-1', leafUuid: null },
              origin: 'created' as const,
              mintedAtFence: 1,
              observedAt: 1
            }
          : {
              linkId: 'codex-link',
              handle: { provider: 'codex' as const, threadId: 'thread-1' },
              origin: 'created' as const,
              mintedAtFence: 1,
              observedAt: 1
            }
    })),
    releaseAcquisition,
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: false })),
    answerPrompt: vi.fn(async () => {}),
    setOption: vi.fn(async () => {}),
    readOptions: vi.fn(async () => ({
      models: [],
      current: { model: `${agent}-model` }
    })),
    historyFilePath: vi.fn(async () => null),
    closeSession,
    disposeSession: closeSession
  } satisfies StructuredAgentSessionAdapter
  return { adapter, dispatch, closeSession, releaseAcquisition }
}

function dispatchInput(sessionId: string) {
  return {
    sessionId,
    clientMessageId: 'client-1',
    body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
    fence: 1
  }
}

describe('StructuredAgentSessionAdapterRouter', () => {
  it('routes every acquired session through its provider owner, including Codex', async () => {
    const claude = fakeAdapter('claude')
    const codex = fakeAdapter('codex')
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: claude.adapter, codex: codex.adapter },
      async () => {}
    )
    await router.acquire({
      identity: identity('codex', 'codex-session'),
      fence: 1,
      spawnToken: 's'
    })
    await router.acquire({
      identity: identity('claude', 'claude-session'),
      fence: 1,
      spawnToken: 's'
    })

    await router.dispatch(dispatchInput('codex-session'))
    await router.dispatch(dispatchInput('claude-session'))

    expect(codex.dispatch).toHaveBeenCalledTimes(1)
    expect(claude.dispatch).toHaveBeenCalledTimes(1)
  })

  it('makes Claude available through router capability, not the Codex fallback', () => {
    const claude = fakeAdapter('claude')
    const codex = fakeAdapter('codex')
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: claude.adapter, codex: codex.adapter },
      async () => {}
    )

    expect(adapterSupportsCreate(router, LOCATION, 'claude')).toBe(true)
    expect(claude.adapter.supportsCreate).toHaveBeenCalledWith(LOCATION, 'claude')
    expect(codex.adapter.supportsCreate).toHaveBeenCalledTimes(0)
  })

  it('retains the owner until provider-child exit is proven', async () => {
    const claude = fakeAdapter('claude')
    const codex = fakeAdapter('codex')
    codex.closeSession.mockResolvedValueOnce(false)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: claude.adapter, codex: codex.adapter },
      async () => {}
    )
    await router.acquire({ identity: identity('codex', 'session-1'), fence: 1, spawnToken: 's' })

    expect(await router.closeSession('session-1')).toBe(false)
    await expect(router.dispatch(dispatchInput('session-1'))).resolves.toMatchObject({
      reason: 'codex'
    })
  })

  it('proves unknown-owner cleanup only when every adapter proves absence', async () => {
    const claude = fakeAdapter('claude')
    const codex = fakeAdapter('codex')
    claude.releaseAcquisition.mockResolvedValueOnce(false)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: claude.adapter, codex: codex.adapter },
      async () => {}
    )

    expect(await router.releaseAcquisition({ sessionId: 'unknown-1' })).toBe(false)
    expect(await router.releaseAcquisition({ sessionId: 'unknown-2' })).toBe(true)
  })
})
