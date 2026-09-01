import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

function isSubscribeEvent(value: unknown): value is AgentSessionSubscribeEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = (value as { type?: unknown }).type
  return type === 'snapshot' || type === 'batch' || type === 'reset' || type === 'end'
}

export function useMobileStructuredAgentState(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}): {
  state: StructuredAgentSessionState
  stateRef: { readonly current: StructuredAgentSessionState }
  loadingOlder: boolean
  loadEarlier: () => void
} {
  const { client, enabled, sessionId } = args
  const [state, setState] = useState<StructuredAgentSessionState>(EMPTY_STRUCTURED_AGENT_SESSION)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  const apply = useCallback((action: StructuredAgentSessionAction) => {
    setState((current) => reduceStructuredAgentSession(current, action))
  }, [])

  useEffect(() => {
    if (!client || !sessionId || !enabled) {
      setState(EMPTY_STRUCTURED_AGENT_SESSION)
      setLoadingOlder(false)
      return
    }
    apply({ type: 'loading' })
    const holderId = structuredAgentSessionHolderId('mobile-chat')
    let cancelled = false
    let unsubscribe = (): void => {}
    const held = callAgentSession(client, 'agentSession.hold', {
      sessionId,
      holderId
    })
    void held
      .then(() => {
        if (cancelled) {
          return
        }
        unsubscribe = client.subscribe('agentSession.subscribe', { sessionId }, (raw) => {
          if (
            typeof raw === 'object' &&
            raw !== null &&
            (raw as { type?: unknown }).type === 'error'
          ) {
            apply({ type: 'error', message: String((raw as { message?: unknown }).message ?? '') })
            return
          }
          if (isSubscribeEvent(raw)) {
            apply({ type: 'event', event: raw })
          }
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          apply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      cancelled = true
      unsubscribe()
      void held
        .then(() =>
          callAgentSession(
            client,
            'agentSession.release',
            {
              sessionId,
              holderId
            },
            undefined,
            { failWhenDisconnected: true }
          ).catch(() => undefined)
        )
        .catch(() => undefined)
    }
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

  return { state, stateRef, loadingOlder, loadEarlier }
}
