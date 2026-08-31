import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { settleClaudeExitedSession } from './claude-structured-session-close'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSession,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export class ClaudeStructuredProviderEvents {
  constructor(
    private readonly sessions: Map<string, ClaudeSession>,
    private readonly onEvent?: (event: ClaudeStructuredSessionEvent) => void
  ) {}

  deliver(attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void): void {
    if (!attempt.published) {
      attempt.buffered.push(event)
      return
    }
    if (this.sessions.get(sessionId)?.connection === attempt.connection) {
      event()
    }
  }

  handleExit(sessionId: string, attempt: ClaudeAcquisitionAttempt, error: Error): void {
    if (attempt.connection) {
      attempt.exitProven = true
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== attempt.connection || session.ended) {
      return
    }
    this.finishExit(sessionId, session, error)
  }

  handleClosed(sessionId: string, error: Error): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return false
    }
    this.finishExit(sessionId, session, error)
    return true
  }

  private finishExit(sessionId: string, session: ClaudeSession, error: Error): void {
    const event = {
      type: 'ended' as const,
      sessionId,
      reason: error.message,
      cause: session.requestedClose ? ('requested-close' as const) : ('unexpected-exit' as const),
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration
    }
    session.ended = true
    this.emit(session, session.events, event)
    settleClaudeExitedSession(session)
  }

  emit(
    session: ClaudeSession | null,
    _events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ): void {
    session?.translator?.handle(event)
    this.onEvent?.(event)
  }
}
