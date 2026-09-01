import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalResolution } from '../../../src/shared/agent-session-journal-types'
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

function pendingResolution(): AgentJournalResolution {
  return {
    state: 'pending',
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
}

function approvalItem(): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: 2,
    sequence: 1,
    observedAt: 10,
    body: {
      kind: 'approval',
      title: 'Allow Bash?',
      detail: 'rm -rf build',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' }
      ],
      resolution: pendingResolution()
    }
  }
}

function questionItem(): AgentJournalRenderItem {
  return {
    itemId: 'question-1',
    revision: 7,
    sequence: 2,
    observedAt: 12,
    body: {
      kind: 'question',
      question: 'Pick destination',
      freeTextQuestionId: 'free-q',
      options: [
        { id: 'choice-a', label: 'Choice A' },
        { id: 'choice-b', label: 'Choice B' }
      ],
      resolution: pendingResolution()
    }
  }
}

describe('useMobileStructuredAgentSession', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const onSendError = vi.fn()
  const unsubscribe = vi.fn()
  const sendRequest = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'agentSession.send') {
      return ok({
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: { turnId: 'turn-1' }
      })
    }
    if (method === 'agentSession.options') {
      return ok({
        models: [
          {
            id: 'gpt-fast',
            label: 'GPT Fast',
            isDefault: true,
            defaultEffort: 'low',
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        current: {
          model: 'gpt-fast',
          effort: 'low'
        }
      })
    }
    if (method === 'agentSession.setOption') {
      return ok({
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 2 },
        value: {
          key: 'model',
          value: 'gpt-fast',
          options: { model: 'gpt-fast' }
        }
      })
    }
    if (method === 'agentSession.respondToApproval' || method === 'agentSession.respondToQuestion') {
      return ok({
        ok: true,
        replayed: false,
        fence: 3,
        cursor: { epoch: 'epoch-1', sequence: 3 },
        value: {
          itemId: String(params?.itemId ?? ''),
          revision: 2,
          resolution: {
            state: 'resolved',
            selectedOptionId: String(params?.optionId ?? ''),
            resolvedBy: 'mobile',
            resolvedAt: 123
          }
        }
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

  function Harness({
    sessionId = 'session-1',
    agent = 'codex'
  }: {
    sessionId?: string | null
    agent?: string | null
  }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      enabled: true,
      agent,
      onSendError
    } as never)
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

  it('surfaces structured prompt cards and option snapshots', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))
    act(() => listener?.(snapshotEvent(3)))
    act(() => listener?.({
      ...snapshotEvent(3),
      page: {
        ...snapshotEvent(3).page,
        items: [approvalItem(), questionItem()]
      }
    }))

    if (!hook) {
      throw new Error('hook not ready')
    }

    await vi.waitFor(() => expect(hook.permission).not.toBeNull())
    await vi.waitFor(() => expect(hook.question).not.toBeNull())
    await vi.waitFor(() => expect(hook.optionSnapshot.length).toBeGreaterThan(0))

    expect(hook.permission).toMatchObject({
      title: 'Allow Bash?',
      detail: 'rm -rf build',
      options: [
        { label: 'Allow once', send: 'allow-once' },
        { label: 'Deny', send: 'deny' }
      ]
    })
    expect(hook.question).toMatchObject({
      question: 'Pick destination',
      allowOther: true,
      optionTokens: ['choice-a', 'choice-b']
    })
    expect(hook.optionSurface.getSnapshot()).toEqual(hook.optionSnapshot)

    await act(async () => {
      expect(await hook.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.setOption',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3,
          clientOperationId: expect.any(String),
          payloadFingerprint: expect.any(String)
        }),
        key: 'model',
        value: 'gpt-fast'
      }),
      expect.any(Object)
    )

    await act(async () => {
      expect(await hook.respondPermission('allow-once')).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToApproval',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3
        }),
        itemId: 'approval-1',
        optionId: 'allow-once'
      }),
      expect.any(Object)
    )

    await act(async () => {
      expect(await hook.respondQuestion('custom answer')).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToQuestion',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3
        }),
        itemId: 'question-1',
        optionId: `${encodeURIComponent('free-q')}:${encodeURIComponent('custom answer')}`
      }),
      expect.any(Object)
    )
  })

  it('sends structured image attachments in the message body', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))

    let outcome: 'accepted' | 'unknown' | 'rejected' = 'rejected'
    await act(async () => {
      outcome = await hook.sendWithOutcome('look at this', undefined, undefined, [
        { path: '/tmp/a.png', previewUri: 'file:///a.jpg' }
      ])
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
          blocks: [
            { type: 'text', text: 'look at this' },
            { type: 'image-ref', path: '/tmp/a.png' }
          ]
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
