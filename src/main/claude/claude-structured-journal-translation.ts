import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeMessageBody,
  claudeMessageIdentity,
  claudeHasReplayContent,
  claudeRecord,
  claudeStreamingMessageBody,
  claudeText,
  claudeThinkingIdentity,
  claudeThinkingText,
  claudeToolBody,
  claudeToolIdentity,
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import {
  claudeApprovalItem,
  claudePromptIdentity,
  claudeQuestionItems
} from './claude-structured-prompt-items'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import {
  claudeProviderFrameKind,
  createClaudeProviderFrameFallback,
  isModeledClaudeContent,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string, questionId?: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
}

export type ClaudeJournalTranslator = {
  handle: (event: ClaudeStructuredSessionEvent) => void
  flush: () => void
  dispose: () => void
}

export function createClaudeSessionJournalTranslator(
  sink: StructuredAgentSessionEventSink | undefined,
  prompts: ClaudePromptRegistry,
  fallbackIdPrefix: string
): ClaudeJournalTranslator | null {
  return sink
    ? createClaudeJournalTranslator({
        sink,
        fallbackIdPrefix,
        bindPromptItemId: (itemId, promptKey, questionId) =>
          prompts.bindJournalItemId(itemId, promptKey, questionId)
      })
    : null
}

function lifecycleIdentity(sessionId: string, turnId: string): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'claude',
    sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

export function createClaudeJournalTranslator(
  deps: ClaudeJournalTranslatorDeps
): ClaudeJournalTranslator {
  const tools = new Map<string, ClaudeToolUse>()
  const promptItems = new Map<string, AgentJournalItemIdentity[]>()
  const streamIdentities = new Map<string, AgentJournalItemIdentity>()
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  const latestStreamText = new Map<string, string>()
  const checkpointLengths = new Map<string, number>()
  let currentTurn: { sessionId: string; turnId: string } | null = null
  const providerFallback = createClaudeProviderFrameFallback(
    deps.sink,
    deps.fallbackIdPrefix ?? 'acquisition'
  )

  const publishLifecycle = (sessionId: string, turnId: string, running: boolean): void => {
    const identity = lifecycleIdentity(sessionId, turnId)
    if (running) {
      deps.sink.appendItem(identity, {
        kind: 'status',
        text: 'Claude is working…',
        turnLifecycle: { turnId, state: 'running' }
      })
    } else {
      deps.sink.appendTombstone(identity)
    }
    deps.sink.publish()
  }

  const persistStream = (key: string, text: string, force: boolean): void => {
    latestStreamText.set(key, text)
    const checkpointLength = checkpointLengths.get(key) ?? 0
    const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
    if (!force && checkpointLength > 0 && text.length < nextLength) {
      return
    }
    const identity = streamIdentities.get(key)
    if (!identity) {
      return
    }
    checkpointLengths.set(key, text.length)
    deps.sink.appendItem(identity, claudeStreamingMessageBody(text))
    deps.sink.publish()
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    windowMs: deps.coalesceMs,
    schedule: deps.schedule,
    emit: (key, text) => persistStream(key, text, false)
  })

  const flushStreams = (): void => {
    coalescer.flushAll()
    for (const [key, text] of latestStreamText) {
      if (checkpointLengths.get(key) !== text.length) {
        persistStream(key, text, true)
      }
    }
  }

  const handleStream = (message: Record<string, unknown>): boolean => {
    const delta = streamedBlocks.observe(message)
    if (!delta) {
      return false
    }
    const key = agentJournalItemKey(delta.identity)
    streamIdentities.set(key, delta.identity)
    coalescer.append(key, delta.text)
    return true
  }

  const handleMessage = (message: Record<string, unknown>): boolean => {
    const envelope = readClaudeMessageEnvelope(message)
    if (!envelope) {
      return false
    }
    let changed = false
    const body = claudeMessageBody(envelope)
    // The final frame of a streamed block lands on the block's identity, not its own uuid.
    const identity =
      (body && envelope.role === 'assistant' ? streamedBlocks.reconcile(envelope) : null) ??
      claudeMessageIdentity(envelope)
    const key = agentJournalItemKey(identity)
    coalescer.forget(key)
    latestStreamText.delete(key)
    checkpointLengths.delete(key)
    streamIdentities.delete(key)
    if (body) {
      deps.sink.appendItem(identity, body)
      changed = true
    }
    for (const tool of claudeToolUses(envelope)) {
      tools.set(tool.id, tool)
      deps.sink.appendItem(
        claudeToolIdentity(envelope.sessionId, tool.id),
        claudeToolBody({ tool })
      )
      changed = true
    }
    for (const result of claudeToolResults(envelope)) {
      const tool = tools.get(result.toolUseId) ?? {
        id: result.toolUseId,
        name: 'tool',
        input: null
      }
      deps.sink.appendItem(
        claudeToolIdentity(envelope.sessionId, result.toolUseId),
        claudeToolBody({ tool, result })
      )
      // Tool inputs are only needed until their matching result arrives.
      tools.delete(result.toolUseId)
      changed = true
    }
    const thinking = claudeThinkingText(envelope)
    if (thinking) {
      deps.sink.appendItem(claudeThinkingIdentity(envelope.sessionId, envelope.uuid), {
        kind: 'status',
        text: boundInlineText(thinking, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      })
      changed = true
    }
    const unhandledContent = envelope.content.filter((part) => !isModeledClaudeContent(part))
    for (const part of unhandledContent) {
      const partType = claudeText(claudeRecord(part)?.type) ?? 'unknown'
      providerFallback.append(`message:${envelope.role}:content:${partType}`, part)
      changed = true
    }
    // An empty user frame is a replay with nothing to show, not an unknown kind.
    if (envelope.content.length === 0 && envelope.role === 'assistant') {
      providerFallback.append(`message:${envelope.role}:empty`, message)
      changed = true
    }
    if (
      envelope.role === 'user' &&
      claudeHasReplayContent(envelope) &&
      message.parent_tool_use_id === null
    ) {
      if (currentTurn) {
        publishLifecycle(currentTurn.sessionId, currentTurn.turnId, false)
      }
      currentTurn = { sessionId: envelope.sessionId, turnId: envelope.uuid }
      publishLifecycle(envelope.sessionId, envelope.uuid, true)
    }
    if (changed) {
      deps.sink.publish()
    }
    return true
  }

  const handlePrompt = (event: Extract<ClaudeStructuredSessionEvent, { type: 'prompt' }>): void => {
    const identities: AgentJournalItemIdentity[] = []
    if (event.prompt.kind === 'question') {
      for (const question of claudeQuestionItems({
        sessionId: event.sessionId,
        prompt: event.prompt
      })) {
        identities.push(question.identity)
        deps.sink.appendItem(question.identity, question.body)
        deps.bindPromptItemId?.(agentJournalItemKey(question.identity), event.prompt.promptKey)
      }
    } else {
      const identity = claudePromptIdentity({
        sessionId: event.sessionId,
        promptKey: event.prompt.promptKey
      })
      identities.push(identity)
      deps.sink.appendItem(identity, claudeApprovalItem(event.prompt))
      deps.bindPromptItemId?.(agentJournalItemKey(identity), event.prompt.promptKey)
    }
    promptItems.set(event.prompt.promptKey, identities)
    deps.sink.publish()
  }

  return {
    handle: (event) => {
      if (event.type === 'ended') {
        flushStreams()
        if (currentTurn) {
          publishLifecycle(currentTurn.sessionId, currentTurn.turnId, false)
          currentTurn = null
        }
        return
      }
      if (event.type === 'message' && handleStream(event.message)) {
        return
      }
      flushStreams()
      if (event.type === 'prompt') {
        handlePrompt(event)
      } else if (event.type === 'prompt-cancelled') {
        for (const identity of promptItems.get(event.promptKey) ?? []) {
          deps.sink.appendTombstone(identity)
        }
        promptItems.delete(event.promptKey)
        deps.sink.publish()
      } else if (event.type === 'message' && event.message.type === 'result') {
        if (currentTurn) {
          publishLifecycle(currentTurn.sessionId, currentTurn.turnId, false)
          currentTurn = null
        }
        // The turn is over: a block still awaiting its final keeps its flushed text.
        streamedBlocks.clear()
        const kind = claudeProviderFrameKind(event.message)
        if (!isSettledClaudeResultKind(kind)) {
          providerFallback.append(kind, event.message)
        }
      } else if (event.type === 'message') {
        if (!handleMessage(event.message)) {
          providerFallback.append(claudeProviderFrameKind(event.message), event.message)
        }
      } else if (event.type === 'provider-frame') {
        providerFallback.append(event.kind, event.payload)
      }
    },
    flush: flushStreams,
    dispose: () => {
      coalescer.dispose()
      tools.clear()
      promptItems.clear()
      streamIdentities.clear()
      streamedBlocks.clear()
      latestStreamText.clear()
      checkpointLengths.clear()
    }
  }
}
