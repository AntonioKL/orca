import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function snapshotEvent(fence = 3): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: null,
        newest: null,
        nextCursor: { epoch: 'epoch-1', sequence: 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

describe('useMobileStructuredAgentSession', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const onSendError = vi.fn()
  const unsubscribe = vi.fn()
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'agentSession.send') {
      return ok({
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: { turnId: 'turn-1' }
      })
    }
    return ok({})
  })
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return unsubscribe
  })
  const client = {
    sendRequest,
    subscribe
  } as unknown as RpcClient

  function Harness({ sessionId = 'session-1' }: { sessionId?: string | null }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      enabled: true,
      onSendError
    })
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    listener = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  it('subscribes and holds structured sessions without nativeChat or terminal RPCs', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })

    await vi.waitFor(() =>
      expect(subscribe).toHaveBeenCalledWith(
        'agentSession.subscribe',
        { sessionId: 'session-1' },
        expect.any(Function)
      )
    )
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.hold',
        expect.objectContaining({ sessionId: 'session-1', holderId: expect.any(String) }),
        expect.any(Object)
      )
    )
    expect(sendRequest).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(nativeChat|terminal)\./),
      expect.anything(),
      expect.anything()
    )
  })

  it('sends with the shared structured mutation envelope after the stream fence lands', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))

    let outcome: 'accepted' | 'unknown' | 'rejected' = 'rejected'
    await act(async () => {
      outcome = await hook!.sendWithOutcome('hello')
    })

    expect(outcome).toBe('accepted')
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3,
          clientOperationId: expect.any(String),
          payloadFingerprint: expect.any(String)
        }),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }]
        }
      }),
      expect.any(Object)
    )
  })

  it('releases a landed hold when the structured tab unmounts', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.hold',
        expect.objectContaining({ sessionId: 'session-1' }),
        expect.any(Object)
      )
    )
    const held = sendRequest.mock.calls.find((call) => call[0] === 'agentSession.hold')?.[1] as {
      holderId: string
    }

    act(() => renderer?.unmount())

    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.release',
        { sessionId: 'session-1', holderId: held.holderId },
        expect.any(Object)
      )
    )
  })
})
