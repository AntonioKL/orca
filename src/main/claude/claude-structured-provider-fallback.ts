import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from '../native-chat/agent-session-wire/claude-stream-json-frame-schema'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export function claudeProviderFrameKind(message: Record<string, unknown>): string {
  const type = claudeText(message.type) ?? 'unknown'
  const subtype = claudeText(message.subtype)
  const eventType = claudeText(claudeRecord(message.event)?.type)
  return ['message', type, subtype ?? eventType].filter(Boolean).join(':')
}

const SETTLED_RESULT_KINDS: ReadonlySet<string> = new Set(
  CLAUDE_STREAM_JSON_FRAME_KINDS.filter((kind) => kind.startsWith('message:result:'))
)

/** A catalogued result subtype is the turn-complete signal the translator settles
 *  itself; only an unmodeled subtype still needs the provider-fallback row. */
export function isSettledClaudeResultKind(kind: string): boolean {
  return SETTLED_RESULT_KINDS.has(kind)
}

export function isModeledClaudeContent(value: unknown): boolean {
  const part = claudeRecord(value)
  if (!part) {
    return false
  }
  if (part.type === 'text') {
    return claudeText(part.text) !== null
  }
  if (part.type === 'image') {
    const source = claudeRecord(part.source)
    return source?.type === 'url' && claudeText(source.url) !== null
  }
  if (part.type === 'tool_use') {
    return claudeText(part.id) !== null && claudeText(part.name) !== null
  }
  if (part.type === 'tool_result') {
    return claudeText(part.tool_use_id) !== null
  }
  // Redacted thinking arrives as an empty string plus a signature.
  return part.type === 'thinking' || part.type === 'redacted_thinking'
}

export function createClaudeProviderFrameFallback(
  sink: StructuredAgentSessionEventSink,
  acquisitionId: string
): {
  append: (kind: string, payload: unknown) => void
} {
  let sequence = 0
  return {
    append: (kind, payload) => {
      sequence += 1
      const translated = unhandledProviderFrameJournalItem('claude', kind, payload)
      if (!translated) {
        return
      }
      sink.appendItem(
        {
          provider: 'orca',
          clientMessageId: `provider-frame:claude:${acquisitionId}:${sequence}`
        },
        translated.body,
        translated.blobs
      )
      sink.publish()
    }
  }
}
