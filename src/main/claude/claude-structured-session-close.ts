import type {
  ClaudeAcquisitionRegistry,
  ClaudeSession,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { cancelClaudeAcquisitionAttempt } from './claude-structured-session-state'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'

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
}): Promise<boolean> {
  const session = input.sessions.get(input.sessionId)
  if (!session) {
    return true
  }
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
  if ((await session.connection.close()) !== true) {
    return false
  }
  input.sessions.delete(input.sessionId)
  let persistenceError: unknown
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
  } finally {
    const ended = {
      type: 'ended',
      sessionId: input.sessionId,
      reason: 'claude session closed'
    } as const
    session.translator?.handle(ended)
    input.onEvent?.(ended)
    session.translator?.dispose()
  }
  if (persistenceError) {
    throw persistenceError
  }
  return true
}

export function closeClaudePublishedSessionForDeps(
  sessions: Map<string, ClaudeSession>,
  sessionId: string,
  deps: {
    persistHandle?: (handle: {
      sessionId: string
      providerSessionId: string
      leafUuid: string | null
      fence: number
    }) => Promise<void>
    onEvent?: (event: ClaudeStructuredSessionEvent) => void
  }
): Promise<boolean> {
  return closeClaudePublishedSession({ sessions, sessionId, ...deps })
}

export async function closeClaudeSession(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
}): Promise<boolean> {
  const attempt = input.acquisitions.get(input.sessionId)
  if (!(await cancelClaudeAcquisitionAttempt(attempt))) {
    return false
  }
  if (attempt) {
    input.acquisitions.deleteIfCurrent(input.sessionId, attempt)
  }
  return closeClaudePublishedSession(input)
}

export async function closeAllClaudeSessions(input: {
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  closeSession: (sessionId: string) => Promise<boolean>
}): Promise<void> {
  input.acquisitions.close()
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () => input.sessions.size > 0 || input.acquisitions.size > 0,
    entryIds: () => new Set([...input.sessions.keys(), ...input.acquisitions.sessionIds()]),
    closeEntry: input.closeSession,
    failureMessage: 'claude structured session shutdown could not prove every child stopped'
  })
}
