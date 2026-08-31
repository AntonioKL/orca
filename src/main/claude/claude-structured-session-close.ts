import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import type { ClaudeStructuredProviderEvents } from './claude-structured-provider-events'

export function settleClaudeDispatchWaiters(session: ClaudeSession): void {
  for (const waiter of session.dispatchWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.resolve(null)
  }
}

export function settleClaudeExitedSession(session: ClaudeSession): void {
  settleClaudeDispatchWaiters(session)
  session.prompts.clear()
  session.translator?.dispose()
}

export async function closeClaudePublishedSession(input: {
  sessions: Map<string, ClaudeSession>
  sessionId: string
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
  providerEvents?: ClaudeStructuredProviderEvents
  requestedClose?: boolean
  expectedFence?: number
  expectedAcquisitionGeneration?: string
  unexpectedReason?: Error
  allowFailedSettlement?: boolean
}): Promise<boolean> {
  const session = input.sessions.get(input.sessionId)
  if (!session) {
    return true
  }
  if (
    (input.expectedFence !== undefined && session.fence !== input.expectedFence) ||
    (input.expectedAcquisitionGeneration !== undefined &&
      session.acquisitionGeneration !== input.expectedAcquisitionGeneration)
  ) {
    return false
  }
  session.requestedClose = input.requestedClose ?? true
  settleClaudeDispatchWaiters(session)
  const pending = session.prompts.clear()
  await Promise.allSettled(
    pending.map((prompt) =>
      session.connection.respond(prompt.requestId, {
        behavior: 'deny',
        message: 'Structured Claude session closed.',
        interrupt: true,
        toolUseID: prompt.toolUseId
      })
    )
  )
  session.translator?.flush()
  if (!(await session.connection.close())) {
    return false
  }
  let persistenceError: unknown
  if (!session.ended && session.requestedClose) {
    try {
      await input.persistHandle?.({
        sessionId: input.sessionId,
        providerSessionId: session.providerSessionId,
        leafUuid: session.leafUuid,
        fence: session.fence
      })
      input.onEvent?.({
        type: 'handle',
        sessionId: input.sessionId,
        providerSessionId: session.providerSessionId,
        leafUuid: session.leafUuid,
        fence: session.fence
      })
    } catch (error) {
      persistenceError = error
    }
  }
  if (!session.ended) {
    input.providerEvents?.handleClosed(
      input.sessionId,
      input.unexpectedReason ?? new Error('claude session closed')
    )
  }
  if (!session.ended) {
    return false
  }
  input.sessions.delete(input.sessionId)
  if (persistenceError) {
    throw persistenceError
  }
  return true
}
