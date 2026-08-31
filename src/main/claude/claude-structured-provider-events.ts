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
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== attempt.connection) {
      return
    }
    this.sessions.delete(sessionId)
    this.emit(session, session.events, { type: 'ended', sessionId, reason: error.message })
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
