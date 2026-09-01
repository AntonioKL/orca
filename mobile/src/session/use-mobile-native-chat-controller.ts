import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'
import { type MobileNativeChatTab, resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { useMobileNativeChatPermissionSend } from './mobile-native-chat-permission-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileNativeChatFileSearch } from './use-mobile-native-chat-file-search'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { mobileNativeChatStreamPreview } from './mobile-native-chat-streaming-gate'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileNativeChatSessionOptions } from './use-mobile-native-chat-session-options'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'
import { useMobileNativeChatTarget } from './use-mobile-native-chat-target'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'
import { useThrottledLatestValue } from './use-throttled-latest-value'
import { isMobileNativeChatAgentWorking } from './mobile-native-chat-working-state'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import {
  resolveMobileNativeChatDuringDisconnect,
  type MobileNativeChatDisconnectRetention
} from './mobile-native-chat-disconnect-retention'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
export type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

const NATIVE_CHAT_STREAM_THROTTLE_MS = 50

/** Owns mobile native-chat state and teardown outside the already dense session
 *  route. The route remains responsible only for choosing and rendering the view. */
export function useMobileNativeChatController(args: {
  operations: HostSessionNativeChatOperations | null
  draftOperations?: HostSessionChatDraftOperations | null
  pendingDeliveryOperations?: HostSessionChatPendingDeliveryOperations | null
  connected: boolean
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
  nativeChatInputLeaseReady: boolean
  onSendError: (message: string) => void
  /** Retires a held failure banner. Any accepted chat write clears it — a delivered
   *  answer or permission reply must not sit under a stale "not sent". */
  onSendResolved: () => void
}): MobileNativeChatController {
  const {
    operations,
    draftOperations = null,
    pendingDeliveryOperations = null,
    connected,
    hostId,
    worktreeId,
    activeSessionTab,
    activeSessionTabId,
    activeHandleRef,
    deviceTokenRef,
    nativeChatTranscriptIsLocalReadable,
    nativeChatInputLeaseReady,
    onSendError,
    onSendResolved
  } = args
  const { isTabChatView, toggleTabChatView } = useMobileSessionViewMode({ hostId, worktreeId })

  const chatViewSelected = activeSessionTabId ? isTabChatView(activeSessionTabId) : false
  const currentChatResolution =
    activeSessionTab && activeSessionTabId && chatViewSelected
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  const disconnectRetentionRef = useRef<MobileNativeChatDisconnectRetention | null>(null)
  const retainedChat = resolveMobileNativeChatDuringDisconnect({
    connected,
    hostId,
    worktreeId,
    tabId: activeSessionTabId,
    terminalTabPresent: activeSessionTab?.type === 'terminal',
    chatViewSelected,
    currentResolution: currentChatResolution,
    retained: disconnectRetentionRef.current
  })
  useEffect(() => {
    disconnectRetentionRef.current = retainedChat.retained
  }, [retainedChat.retained])
  const activeChatResolution = retainedChat.resolution
  const showNativeChat = activeChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgentRef = useRef<string | null>(activeChatResolution?.agent ?? null)
  useEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatResolution?.agent ?? null
  }, [activeChatResolution?.agent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeTerminalId = activeHandleRef.current
  const nativeClientId = deviceTokenRef.current
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeTerminalId ?? ''}`
  const streamScopeKey = `${routeKey}\0${activeSessionTab?.agentStatus?.providerSession?.id ?? ''}\0${activeTerminalId ?? ''}`

  const { target: nativeChatTarget, targetRef: nativeChatTargetRef } = useMobileNativeChatTarget({
    workspaceId: worktreeId,
    agent: activeChatResolution?.agent ?? null,
    sessionId: activeChatResolution?.sessionId ?? null,
    transcriptPath: activeChatResolution?.transcriptPath ?? null,
    terminalId: activeTerminalId,
    clientId: nativeClientId
  })
  const nativeChatSession = useMobileNativeChatSession({
    operations,
    workspaceId: worktreeId,
    agent: activeChatResolution?.agent ?? null,
    sessionId: activeChatSessionId,
    transcriptPath: activeChatResolution?.transcriptPath ?? null,
    terminalId: nativeChatTarget?.terminalId ?? null,
    clientId: nativeChatTarget?.clientId ?? null
  })
  const {
    composerText: chatComposerText,
    setComposerText: setChatComposerText,
    getComposerEditGeneration: getChatComposerEditGeneration,
    pending: chatPending,
    imagePreviewsByMessageId: chatImagePreviewsByMessageId,
    captureSendOrigin,
    readSeededLaunchDraft,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  } = useMobileNativeChatDrafts({
    hostId,
    worktreeId,
    tabId: activeSessionTabId,
    sessionId: activeChatSessionId,
    messages: nativeChatSession.messages,
    launchDraft: activeSessionTab?.launchDraft ?? null,
    launchDraftCreatedAt: activeSessionTab?.launchDraftCreatedAt ?? null,
    // Why: pass the raw draft plus this flag rather than nulling it off-chat —
    // a null is indistinguishable from a host retraction, and peeking at the
    // terminal view would permanently decline the prefill.
    chatActive: showNativeChat,
    transcriptLoading: nativeChatSession.transcriptLoading,
    persistence: draftOperations,
    pendingPersistence: pendingDeliveryOperations,
    transcriptSettled: nativeChatSession.status === 'ready'
  })

  const nativeChatStatus = activeChatResolution ? activeSessionTab?.agentStatus : null
  const nativeChatAgentWorking = isMobileNativeChatAgentWorking(
    nativeChatStatus,
    nativeChatSession.lifecycle
  )
  const nativeChatStreamLive = activeSessionTab?.agentStatus?.state === 'working'
  // Throttle the streaming bubble: OpenCode emits a status frame per streamed
  // part, and each one re-renders and re-parses the whole accumulated markdown.
  const nativeChatStreamingText = useThrottledLatestValue(
    mobileNativeChatStreamPreview(nativeChatStatus, nativeChatAgentWorking),
    NATIVE_CHAT_STREAM_THROTTLE_MS
  )
  const {
    permission: nativeChatPermission,
    question: nativeChatQuestion,
    detectedAsk: nativeChatDetectedAsk,
    ask: nativeChatAskPrompt
  } = useMobileNativeChatPrompts({
    enabled: activeChatResolution != null,
    status: nativeChatStatus,
    messages: nativeChatSession.messages,
    transcriptLoading: nativeChatSession.transcriptLoading
  })
  // A never-read transcript cannot prove that a dismissed prompt cleared.
  const nativeChatTranscriptSettled =
    nativeChatSession.status === 'ready' ||
    (nativeChatSession.status === 'error' && nativeChatSession.messages.length > 0)
  const nativeChatAskObservable =
    showNativeChat && (nativeChatDetectedAsk != null || nativeChatTranscriptSettled)
  const {
    askKey: nativeChatAskKey,
    showAsk: showNativeChatAsk,
    dismissAsk: dismissNativeChatAsk
  } = useMobileNativeChatAskDismiss({
    ask: nativeChatAskPrompt,
    detectedAsk: nativeChatDetectedAsk,
    scopeKey: activeSessionTabId,
    sessionKey: activeChatSessionId,
    observing: nativeChatAskObservable
  })

  // The explicit transport state collapses before the input lease on disconnect.
  const inputSendable = nativeChatInputLeaseReady && connected

  const { answerAsk: handleNativeChatAnswerAsk, cancelPending: cancelNativeChatAnswer } =
    useMobileNativeChatAnswerSend({
      operations,
      enabled: inputSendable,
      targetRef: nativeChatTargetRef,
      agentRef: activeChatAgentRef,
      sessionId: activeChatSessionId,
      streamIdentity,
      onSendError
    })

  const handleNativeChatCancelAsk = useCallback(async (): Promise<boolean> => {
    const target = nativeChatTargetRef.current
    if (!operations || !target || !inputSendable) {
      onSendError('Cancel not sent (disconnected)')
      return false
    }
    cancelNativeChatAnswer()
    const outcome = await operations.respond(target, String.fromCharCode(27), false)
    if (outcome === 'unknown') {
      // Why: the Escape may have landed (ack lost / path cutover) — a definite
      // "not sent" would invite a second Escape into a changed prompt state.
      onSendError('Cancel unconfirmed — check chat before retrying')
    } else if (outcome === 'rejected') {
      onSendError('Cancel not sent')
    }
    return outcome === 'accepted'
  }, [cancelNativeChatAnswer, inputSendable, onSendError, operations])

  const handleNativeChatRespondPermission = useMobileNativeChatPermissionSend({
    operations,
    targetRef: nativeChatTargetRef,
    enabled: inputSendable,
    onSendError
  })

  const handleNativeChatStop = useMobileNativeChatStop({
    operations,
    targetRef: nativeChatTargetRef,
    enabled: inputSendable,
    streamIdentity,
    cancelPending: cancelNativeChatAnswer,
    onSendError
  })

  const { nativeChatFilePaths, loadNativeChatFiles } = useMobileNativeChatFileSearch({
    operations,
    target: nativeChatTarget
  })

  // Why: the send seam reports outgoing catalog commands to session-option
  // tracking, but the options hook needs the seam's dispatcher — a ref breaks
  // the cycle without re-creating the send callbacks per snapshot.
  const recordSessionOptionCommandRef = useRef<(command: string) => void>(() => {})

  const {
    send: handleNativeChatSend,
    sendWithOutcome: handleNativeChatSendWithOutcome,
    answerQuestion: handleNativeChatQuestionAnswer,
    dispatchCommand: handleNativeChatDispatchCommand
  } = useMobileNativeChatMessageSend({
    operations,
    enabled: inputSendable,
    targetRef: nativeChatTargetRef,
    agentRef: activeChatAgentRef,
    commandSendRef: recordSessionOptionCommandRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    onSendError
  })

  // Bring the terminal view forward when an agent-owned picker command is used.
  const handleAgentPicker = useCallback(() => {
    if (activeSessionTabId && isTabChatView(activeSessionTabId)) {
      toggleTabChatView(activeSessionTabId)
    }
  }, [activeSessionTabId, isTabChatView, toggleTabChatView])

  const sessionOptions = useMobileNativeChatSessionOptions({
    agent: activeChatResolution?.agent ?? null,
    scopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    reportedModel: activeSessionTab?.agentStatus?.model ?? null,
    dispatchCommand: handleNativeChatDispatchCommand,
    onAgentPicker: handleAgentPicker
  })
  useLayoutEffect(() => {
    recordSessionOptionCommandRef.current = sessionOptions.recordCommand
  }, [sessionOptions.recordCommand])
  // Card actions retire the route's held failure banner too, not just sends.
  const answerAsk = useNativeChatAcceptedAction(handleNativeChatAnswerAsk, onSendResolved)
  const cancelAsk = useNativeChatAcceptedAction(handleNativeChatCancelAsk, onSendResolved)
  const respond = useNativeChatAcceptedAction(handleNativeChatRespondPermission, onSendResolved)

  return {
    isTabChatView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    nativeChatAgent: activeChatResolution?.agent ?? null,
    chatComposerText,
    setChatComposerText,
    getChatComposerEditGeneration,
    chatPending,
    chatImagePreviewsByMessageId,
    nativeChatSession,
    nativeChatAgentWorking,
    nativeChatTargetRef,
    nativeChatStreamingText,
    nativeChatStreamLive,
    nativeChatStreamScopeKey: streamScopeKey,
    nativeChatPermission,
    nativeChatQuestion,
    nativeChatAsk: showNativeChatAsk ? nativeChatAskPrompt : null,
    nativeChatAskKey,
    dismissNativeChatAsk,
    handleNativeChatAnswerAsk: answerAsk,
    handleNativeChatCancelAsk: cancelAsk,
    handleNativeChatRespondPermission: respond,
    handleNativeChatStop,
    nativeChatFilePaths,
    loadNativeChatFiles,
    handleNativeChatQuestionAnswer,
    handleNativeChatSend,
    handleNativeChatSendWithOutcome,
    readSeededLaunchDraft,
    nativeChatSessionOptions:
      sessionOptions.snapshot.length > 0
        ? { controller: sessionOptions, isWorking: nativeChatAgentWorking }
        : null
  }
}
