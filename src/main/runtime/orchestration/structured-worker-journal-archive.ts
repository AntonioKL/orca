/**
 * Freezing and re-reading a structured worker's journal.
 *
 * The terminal path archives a redacted PTY tail; there is no PTY here, so the durable evidence is
 * the journal projected into the same message shape `worker-read --source transcript` already
 * serves. It gets its own archive kind because its identity is a session, not a transcript file on
 * disk, and because the read side must be able to say which of the three it is holding.
 */

import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { boundWorkerTranscriptTail } from './worker-transcript-payload'

// Same durable bound the terminal archive uses; a session journal can grow without limit.
const STRUCTURED_ARCHIVE_MAX_BYTES = 262_144

export type WorkerStructuredJournalArchive = {
  version: 1
  agent: AgentType
  processIncarnation: string
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
}

export function buildStructuredJournalArchive(input: {
  agent: AgentType
  processIncarnation: string
  items: readonly AgentJournalRenderItem[]
  hasOlder: boolean
}): WorkerStructuredJournalArchive {
  const projected = projectStructuredItemsToNativeChat(input.items)
  // One newest-first pass, never the forward wire bound first: that one keeps the HEAD, so a long
  // worker's archive ended at its early exploration and dropped the answer it was released for —
  // under a warning that said the OLDEST messages had gone.
  // Redacts dispatch capabilities and clips oversized blocks, exactly as the transcript path does.
  const bounded = boundWorkerTranscriptTail(projected, STRUCTURED_ARCHIVE_MAX_BYTES)
  const warnings = [...bounded.warnings]
  if (input.hasOlder) {
    warnings.push('Older journal items were omitted from the bounded archive.')
  }
  if (bounded.limited) {
    warnings.push('The oldest archived journal messages were dropped to fit the size bound.')
  }
  return {
    version: 1,
    agent: input.agent,
    processIncarnation: input.processIncarnation,
    messages: bounded.messages,
    limited: bounded.limited || input.hasOlder,
    warnings
  }
}
