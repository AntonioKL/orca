import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

export function prepareStructuredAgentSessionOutboxRetry(args: {
  clientMessageId: string
  createOperationId: () => string
  entries: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
}): {
  entries: StructuredAgentSessionOutboxEntry[]
  nextClientMessageId: string
} {
  const { clientMessageId, createOperationId, entries, submissions } = args
  const submission = submissions.find((candidate) => candidate.clientMessageId === clientMessageId)
  const current = entries.find((entry) => entry.clientMessageId === clientMessageId)
  // A settled rejection must use a fresh operation id or the host replays it forever.
  const nextClientMessageId =
    current && submission?.dispatchState === 'rejected' ? createOperationId() : clientMessageId
  const retryAfterUnknownSubmittedAt =
    submission?.dispatchState === 'unknown'
      ? submission.submittedAt
      : current?.state === 'unconfirmed'
        ? -1
        : null
  return {
    entries: entries.map((entry) =>
      entry.clientMessageId === clientMessageId
        ? {
            ...entry,
            clientMessageId: nextClientMessageId,
            state: 'queued' as const,
            retryAfterUnknownSubmittedAt:
              nextClientMessageId === clientMessageId ? retryAfterUnknownSubmittedAt : null
          }
        : entry
    ),
    nextClientMessageId
  }
}
