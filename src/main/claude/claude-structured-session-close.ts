import type {
  ClaudeAcquisitionRegistry,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { cancelClaudeAcquisitionAttempt } from './claude-structured-session-state'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import { readClaudeTranscriptLeafWithReproof } from './claude-transcript-branch-proof'

export function claudeAcquisitionCleanupError(
  connection: ClaudeStreamJsonConnection | null | undefined,
  cause: unknown
): Error {
  const verdict = connection?.exitVerdict
  if (verdict?.root === 'processless') {
    return new AgentSessionPreSpawnError(cause)
  }
  return verdict?.root === 'exited' && verdict.tree === 'unverifiable'
    ? new AgentSessionAcquisitionRootExitObservedError(cause)
    : new AgentSessionAcquisitionExitUnprovenError(cause)
}

export function settleClaudeDispatchWaiters(session: ClaudeSession): void {
  for (const waiter of session.dispatchWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.resolve(null)
  }
}

export function settleClaudeExitedSession(session: ClaudeSession): void {
  settleClaudeDispatchWaiters(session)
  for (const prompt of session.prompts.clear()) {
    prompt.settle(null)
  }
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
  readTranscriptLeaf?: (input: {
    providerSessionId: string
    previousLeafUuid: string | null
    claudeConfigDir: string
  }) => Promise<string | null>
}): Promise<boolean> {
  const session = input.sessions.get(input.sessionId)
  if (!session) {
    return true
  }
  if (session.closeFinalized) {
    return true
  }
  settleClaudeDispatchWaiters(session)
  // Settle every in-flight permission callback so closing leaves no dangling promise; `null`
  // writes no response, and the SDK ignores any post-cleanup answer regardless.
  for (const prompt of session.prompts.clear()) {
    prompt.settle(null)
  }
  if ((await session.connection.close()) !== true) {
    return false
  }
  try {
    const transcriptLeaf = input.readTranscriptLeaf
      ? await readClaudeTranscriptLeafWithReproof({
          readTranscriptLeaf: input.readTranscriptLeaf,
          providerSessionId: session.providerSessionId,
          previousLeafUuid: session.leafUuid,
          claudeConfigDir: session.claudeConfigDir
        })
      : null
    if (transcriptLeaf) {
      session.leafUuid = transcriptLeaf
    }
  } catch {
    // Keep the last observed main-transcript frame when the durable tail is
    // unavailable or proves a stale/divergent branch.
  }
  const persistence =
    session.closePersistence ??
    (session.closePersistence = (async () => {
      await input.persistHandle?.({
        sessionId: input.sessionId,
        providerSessionId: session.providerSessionId,
        leafUuid: session.leafUuid,
        fence: session.fence
      })
    })())
  try {
    await persistence
  } catch (error) {
    // Keep the closed session indexed so a retry can persist the same cursor.
    // Removing it first would turn a durable-write failure into a no-op retry.
    if (session.closePersistence === persistence) {
      session.closePersistence = undefined
    }
    throw error
  }
  session.closeFinalized = true
  input.sessions.delete(input.sessionId)
  const ended = {
    type: 'ended',
    sessionId: input.sessionId,
    reason: 'claude session closed'
  } as const
  try {
    input.onEvent?.({
      type: 'handle',
      sessionId: input.sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid: session.leafUuid,
      fence: session.fence
    })
    session.translator?.handle(ended)
    input.onEvent?.(ended)
  } finally {
    session.translator?.dispose()
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
    readTranscriptLeaf?: (input: {
      providerSessionId: string
      previousLeafUuid: string | null
      claudeConfigDir: string
    }) => Promise<string | null>
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
  readTranscriptLeaf?: (input: {
    providerSessionId: string
    previousLeafUuid: string | null
    claudeConfigDir: string
  }) => Promise<string | null>
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
  exits: Map<string, ClaudeSessionExit>
  closeSession: (sessionId: string) => Promise<boolean>
  closeExit: (sessionId: string) => Promise<boolean>
}): Promise<void> {
  input.acquisitions.close()
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () =>
      input.sessions.size > 0 || input.acquisitions.size > 0 || input.exits.size > 0,
    entryIds: () =>
      new Set([
        ...input.sessions.keys(),
        ...input.acquisitions.sessionIds(),
        ...input.exits.keys()
      ]),
    closeEntry: async (sessionId) =>
      input.exits.has(sessionId) ? input.closeExit(sessionId) : input.closeSession(sessionId),
    failureMessage: 'claude structured session shutdown could not prove every child stopped'
  })
}
