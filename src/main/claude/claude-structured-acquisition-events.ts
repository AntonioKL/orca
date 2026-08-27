import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeControlRequest, ClaudeControlResponder } from './claude-stream-json-connection'
import { resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import {
  handleClaudeInboundControl,
  handleClaudeInboundControlCancel
} from './claude-structured-inbound-control'
import type { ClaudeInitDeadline } from './claude-structured-init-deadline'
import { readClaudeInit } from './claude-structured-init-proof'
import type { ClaudeStructuredProviderEvents } from './claude-structured-provider-events'
import {
  observeClaudeTopLevelLeaf,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export class ClaudeStructuredAcquisitionEvents {
  private session: ClaudeSession | null = null
  private leafUuid: string | null = null

  constructor(
    private readonly sessionId: string,
    private readonly attempt: ClaudeAcquisitionAttempt,
    private readonly sink: StructuredAgentSessionEventSink | undefined,
    private readonly initDeadline: ClaudeInitDeadline,
    private readonly providerEvents: ClaudeStructuredProviderEvents
  ) {}

  observeResumeLeaf(leafUuid: string | null): void {
    this.leafUuid = leafUuid
  }

  publish(session: ClaudeSession): void {
    this.session = session
  }

  observedLeaf(): string | null {
    return this.leafUuid
  }

  emit(event: ClaudeStructuredSessionEvent): void {
    this.providerEvents.deliver(this.attempt, this.sessionId, () =>
      this.providerEvents.emit(this.session, this.sink, event)
    )
  }

  onMessage = (message: Record<string, unknown>): void => {
    const init = readClaudeInit(message)
    if (init) {
      this.initDeadline.resolve(init)
    }
    this.leafUuid = observeClaudeTopLevelLeaf(this.leafUuid, message)
    if (this.session) {
      this.session.leafUuid = this.leafUuid
      resolveClaudeReplayWaiter(this.session, message)
    }
    this.emit({ type: 'message', sessionId: this.sessionId, message })
  }

  onControlRequest = (request: ClaudeControlRequest, responder?: ClaudeControlResponder): void => {
    handleClaudeInboundControl({
      sessionId: this.sessionId,
      attempt: this.attempt,
      request,
      responder,
      emit: (event) => this.emit(event)
    })
  }

  onControlCancelRequest = ({ request_id: requestId }: { request_id: string }): void => {
    handleClaudeInboundControlCancel({
      sessionId: this.sessionId,
      attempt: this.attempt,
      requestId,
      emit: (event) => this.emit(event)
    })
  }
}
