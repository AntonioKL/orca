import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { getAgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type {
  AgentSessionCancelResult,
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult,
  AgentSessionSendResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-outbox'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import {
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-projection'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../src/shared/structured-agent-session-options'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'

const STRUCTURED_SEND_TIMEOUT_MS = 15_000

type StructuredApprovalItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' }>
}

type StructuredQuestionItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'question' }>
}

type StructuredMobileAttachment = StructuredAgentSessionAttachment & { id?: string }

type StructuredMobileSession = {
  session: MobileNativeChatSession
  isWorking: boolean
  turnId: string | null
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileAttachment[]
  ) => Promise<MobileNativeChatSendOutcome>
  cancel: () => void
  permission: MobileChatPermission | null
  question: MobileChatQuestion | null
  optionSnapshot: SessionOptionDescriptor[]
  optionSurface: SessionOptionsSurface
  pendingOptionId: string | null
  respondPermission: (optionId: string) => Promise<boolean>
  respondQuestion: (answer: string) => Promise<boolean>
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeStructuredOption: (id: string) => Promise<boolean>
}

async function callAgentSession<TResult>(
  client: RpcClient,
  method: string,
  params: unknown,
  timeoutMs = STRUCTURED_SEND_TIMEOUT_MS
): Promise<TResult> {
  const response = await client.sendRequest(method, params, {
    timeoutMs,
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

function pendingStructuredApproval(item: AgentJournalRenderItem): item is StructuredApprovalItem {
  return item.body.kind === 'approval' && item.body.resolution.state === 'pending'
}

function pendingStructuredQuestion(item: AgentJournalRenderItem): item is StructuredQuestionItem {
  return item.body.kind === 'question' && item.body.resolution.state === 'pending'
}

function encodeQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

function projectStructuredPermission(prompt: StructuredApprovalItem | null): MobileChatPermission | null {
  if (prompt?.body.kind !== 'approval') {
    return null
  }
  return {
    title: prompt.body.title,
    ...(prompt.body.detail ? { detail: prompt.body.detail } : {}),
    options: prompt.body.options.map((option) => ({ label: option.label, send: option.id }))
  }
}

function projectStructuredQuestion(prompt: StructuredQuestionItem | null): MobileChatQuestion | null {
  if (prompt?.body.kind !== 'question') {
    return null
  }
  return {
    question: prompt.body.question,
    options: prompt.body.options.map((option) => option.label),
    multiSelect: false,
    allowOther: Boolean(prompt.body.freeTextQuestionId),
    optionTokens: prompt.body.options.map((option) => option.id)
  }
}

function promptAnswerOptionId(prompt: StructuredQuestionItem, answer: string): string | null {
  const trimmed = answer.trim()
  const option = prompt.body.options.find(
    (candidate) => candidate.id === answer || candidate.label === trimmed
  )
  if (option) {
    return option.id
  }
  return prompt.body.freeTextQuestionId && trimmed
    ? encodeQuestionAnswer(prompt.body.freeTextQuestionId, trimmed)
    : null
}

function timeoutForDeadline(deadline: number | undefined): number | null {
  if (deadline === undefined) {
    return STRUCTURED_SEND_TIMEOUT_MS
  }
  const timeoutMs = deadline - Date.now()
  return timeoutMs >= MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS ? timeoutMs : null
}

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  agent: string | null
  onSendError: (message: string) => void
}): StructuredMobileSession {
  const { agent, client, sessionId, enabled, onSendError } = args
  const [state, setState] = useState<StructuredAgentSessionState>(EMPTY_STRUCTURED_AGENT_SESSION)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex')
  )
  const stateRef = useRef(state)
  stateRef.current = state
  const activeOptionRecordRef = useRef(optionState.record)
  const optionCatalog = useMemo(
    () => (agent === 'claude' || agent === 'codex' ? getAgentSessionOptionCatalog(agent) : null),
    [agent]
  )

  const apply = useCallback((action: StructuredAgentSessionAction) => {
    setState((current) => reduceStructuredAgentSession(current, action))
  }, [])

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent ?? 'codex')
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, sessionId, state.fence])

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

  useEffect(() => {
    if (!client || !sessionId || !enabled || !optionCatalog) {
      return
    }
    let stale = false
    void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', { sessionId })
      .then((result) => {
        if (!stale) {
          setOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
              : current
          )
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client, enabled, optionCatalog, sessionId, state.fence])

  const mutate = useCallback(
    async <TValue,>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>
    ): Promise<TValue | null> => {
      const current = stateRef.current
      if (!client || !sessionId || !enabled || current.fence === null) {
        return null
      }
      const targetFence = current.fence
      try {
        const result = await callAgentSession<AgentSessionMutationResult<TValue>>(client, method, {
          envelope: {
            sessionId,
            clientOperationId: structuredSessionOperationId(),
            expectedRuntimeFence: targetFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
        if (!result.ok) {
          onSendError(result.refusal.message)
          return null
        }
        return stateRef.current.fence === targetFence ? result.value : null
      } catch (error) {
        if (!isRpcDeliveryUnknown(error) && !isLogicalClientCutoverError(error)) {
          onSendError(error instanceof Error ? error.message : 'Request not sent')
        }
        return null
      }
    },
    [client, enabled, onSendError, sessionId]
  )

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      if (
        !canSetStructuredAgentSessionOption(optionState, id, value) ||
        typeof value !== 'string'
      ) {
        return false
      }
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value }
        )
        if (result && activeOptionRecordRef.current === targetRecord) {
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, result.options ?? { [id]: value })
              : current
          )
        }
        return Boolean(result)
      } finally {
        setOptionState((current) =>
          current.record === targetRecord && current.pendingId === id
            ? { ...current, pendingId: null }
            : current
        )
      }
    },
    [mutate, optionState]
  )

  const invokeStructuredOption = useCallback(async () => false, [])

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return { snapshot: optionSnapshot }
    },
    [optionSnapshot, setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption]
  )

  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      if (!client || !sessionId || !enabled || stateRef.current.fence === null) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const timeoutMs = timeoutForDeadline(deadline)
      if (timeoutMs === null) {
        onSendError('Message not sent')
        return 'rejected'
      }
      const sendAttachments =
        attachments ??
        images?.map((previewUri) => ({
          path: previewUri,
          previewUri
        })) ??
        []
      const body = structuredAgentSessionSendBody(text, sendAttachments)
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
          },
          timeoutMs
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

  const respondPermission = useCallback(
    async (optionId: string): Promise<boolean> => {
      const prompt =
        stateRef.current.items.find(pendingStructuredApproval) ?? null
      const option = prompt?.body.options.find(
        (candidate) => candidate.id === optionId || candidate.label === optionId
      )
      if (!prompt || !option) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: option.id }
      )
      return Boolean(result)
    },
    [mutate]
  )

  const respondQuestion = useCallback(
    async (answer: string): Promise<boolean> => {
      const prompt =
        stateRef.current.items.find(pendingStructuredQuestion) ?? null
      if (!prompt) {
        return false
      }
      const optionId = promptAnswerOptionId(prompt, answer)
      if (!optionId) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToQuestion',
        'agentSession.respondTo:question',
        { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId }
      )
      return Boolean(result)
    },
    [mutate]
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
  const approvalPrompt = useMemo(
    () => state.items.find(pendingStructuredApproval) ?? null,
    [state.items]
  )
  const questionPrompt = useMemo(
    () => state.items.find(pendingStructuredQuestion) ?? null,
    [state.items]
  )

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
    cancel,
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt),
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    respondPermission,
    respondQuestion,
    setStructuredOption,
    invokeStructuredOption
  }
}
