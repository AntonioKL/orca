import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentSessionCancelResult,
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-outbox'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-projection'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'

const STRUCTURED_SEND_TIMEOUT_MS = 15_000

type StructuredMobileSession = {
  session: MobileNativeChatSession
  isWorking: boolean
  turnId: string | null
  sendWithOutcome: (text: string, images?: string[]) => Promise<MobileNativeChatSendOutcome>
  cancel: () => void
}

async function callAgentSession<TResult>(
  client: RpcClient,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await client.sendRequest(method, params, {
    timeoutMs: STRUCTURED_SEND_TIMEOUT_MS,
    budgetSpansConnect: true
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

function structuredSessionOperationId(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}-${random}`
}

function isSubscribeEvent(value: unknown): value is AgentSessionSubscribeEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = (value as { type?: unknown }).type
  return type === 'snapshot' || type === 'batch' || type === 'reset' || type === 'end'
}

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  onSendError: (message: string) => void
}): StructuredMobileSession {
  const { client, sessionId, enabled, onSendError } = args
  const [state, setState] = useState<StructuredAgentSessionState>(EMPTY_STRUCTURED_AGENT_SESSION)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const apply = useCallback((action: StructuredAgentSessionAction) => {
    setState((current) => reduceStructuredAgentSession(current, action))
  }, [])

  useEffect(() => {
    if (!client || !sessionId || !enabled) {
      return
    }
    const holderId = structuredAgentSessionHolderId('mobile-chat')
    const held = callAgentSession(client, 'agentSession.hold', {
      sessionId,
      holderId
    }).catch(() => undefined)
    return () => {
      void held.then(() =>
        callAgentSession(client, 'agentSession.release', {
          sessionId,
          holderId
        }).catch(() => undefined)
      )
    }
  }, [client, enabled, sessionId])

  useEffect(() => {
    if (!client || !sessionId || !enabled) {
      setState(EMPTY_STRUCTURED_AGENT_SESSION)
      setLoadingOlder(false)
      return
    }
    apply({ type: 'loading' })
    const unsubscribe = client.subscribe('agentSession.subscribe', { sessionId }, (raw) => {
      if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'error') {
        apply({ type: 'error', message: String((raw as { message?: unknown }).message ?? '') })
        return
      }
      if (isSubscribeEvent(raw)) {
        apply({ type: 'event', event: raw })
      }
    })
    return unsubscribe
  }, [apply, client, enabled, sessionId])

  const loadEarlier = useCallback(() => {
    const current = stateRef.current
    if (!client || !sessionId || loadingOlder || !current.hasOlder) {
      return
    }
    const cursor = oldestStructuredAgentSessionCursor(current)
    if (!cursor) {
      return
    }
    setLoadingOlder(true)
    void callAgentSession<AgentSessionHistoryResult>(client, 'agentSession.history', {
      sessionId,
      direction: 'before',
      cursor,
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
      .then((result) => {
        if (result.ok) {
          apply({ type: 'older-page', requestedEpoch: cursor.epoch, page: result.page })
        }
      })
      .catch((error: unknown) => {
        apply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => setLoadingOlder(false))
  }, [apply, client, loadingOlder, sessionId])

  const sendWithOutcome = useCallback(
    async (text: string, images?: string[]): Promise<MobileNativeChatSendOutcome> => {
      if (!client || !sessionId || !enabled || stateRef.current.fence === null) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      if (images?.length) {
        onSendError('Image send is not available for this chat')
        return 'rejected'
      }
      const body = structuredAgentSessionSendBody(text, [])
      if (body.blocks.length === 0) {
        return 'rejected'
      }
      const fields = { body }
      const clientMessageId = structuredSessionOperationId()
      try {
        const result = await callAgentSession<AgentSessionMutationResult<AgentSessionSendResult>>(
          client,
          'agentSession.send',
          {
            envelope: {
              sessionId,
              clientOperationId: clientMessageId,
              expectedRuntimeFence: stateRef.current.fence,
              payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                method: 'agentSession.send',
                sessionId,
                fields
              })
            },
            ...fields
          }
        )
        if (!result.ok) {
          onSendError(result.refusal.message)
          return 'rejected'
        }
        return 'accepted'
      } catch (error) {
        if (isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)) {
          return 'unknown'
        }
        onSendError(error instanceof Error ? error.message : 'Message not sent')
        return 'rejected'
      }
    },
    [client, enabled, onSendError, sessionId]
  )

  const cancel = useCallback(() => {
    const current = stateRef.current
    const turnId = activeStructuredAgentSessionTurnId(current.items)
    if (!client || !sessionId || !enabled || current.fence === null || !turnId) {
      onSendError('Stop not sent')
      return
    }
    const fields = { turnId }
    void callAgentSession<AgentSessionMutationResult<AgentSessionCancelResult>>(
      client,
      'agentSession.cancel',
      {
        envelope: {
          sessionId,
          clientOperationId: structuredSessionOperationId(),
          expectedRuntimeFence: current.fence,
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.cancel',
            sessionId,
            fields
          })
        },
        ...fields
      }
    )
      .then((result) => {
        if (!result.ok) {
          onSendError(result.refusal.message)
        }
      })
      .catch((error: unknown) => {
        if (!isRpcDeliveryUnknown(error) && !isLogicalClientCutoverError(error)) {
          onSendError(error instanceof Error ? error.message : 'Stop not sent')
        }
      })
  }, [client, enabled, onSendError, sessionId])

  const messages = useMemo(
    () => projectStructuredAgentSessionMessages(state.items, [], state.submissions),
    [state.items, state.submissions]
  )
  const status = state.status === 'idle' ? 'idle' : state.status

  return {
    session: {
      messages,
      status,
      transcriptLoading: status === 'loading',
      error: state.error,
      hasMore: state.hasOlder,
      loadingEarlier: loadingOlder,
      loadEarlier
    },
    isWorking: activeStructuredAgentSessionTurnId(state.items) !== null,
    turnId: activeStructuredAgentSessionTurnId(state.items),
    sendWithOutcome,
    cancel
  }
}
