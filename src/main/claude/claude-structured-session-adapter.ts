import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { answerClaudePrompt, cancelClaudeTurn } from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import {
  acquireClaudeSession,
  releaseClaudeAcquisition
} from './claude-structured-session-acquisition'
export { CLAUDE_STRUCTURED_INIT_TIMEOUT_MS } from './claude-structured-session-acquisition'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { setClaudeStructuredOption } from './claude-structured-options'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import {
  ClaudeAcquisitionRegistry,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import {
  closeAllClaudeSessions,
  closeClaudeSession,
  settleClaudeExitedSession
} from './claude-structured-session-close'
import { readClaudeTranscriptLeafWithReproof } from './claude-transcript-branch-proof'

export type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
export type {
  ClaudeAuthDiagnostic,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

const DISPATCH_ACK_TIMEOUT_MS = 10_000

export class ClaudeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly acquisitions = new ClaudeAcquisitionRegistry()
  private readonly exits = new Map<string, ClaudeSessionExit>()

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {}

  supportsLocation = supportsClaudeStructuredLocation

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    acquireClaudeSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      callbacks: {
        deliver: (attempt, sessionId, event) => this.deliver(attempt, sessionId, event),
        emit: (session, events, event) => this.emit(session, events, event),
        handleExit: (sessionId, attempt, error) => this.handleExit(sessionId, attempt, error)
      }
    })

  private deliver(attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void): void {
    if (!attempt.published) {
      attempt.buffered.push(event)
      return
    }
    if (this.sessions.get(sessionId)?.connection === attempt.connection) {
      event()
    }
  }

  private handleExit(sessionId: string, attempt: ClaudeAcquisitionAttempt, error: Error): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== attempt.connection) {
      return
    }
    this.sessions.delete(sessionId)
    this.exits.set(sessionId, { connection: session.connection, error })
    // Persist the transcript-derived cursor before publishing the lifecycle
    // event that lets the host release and reacquire this exact child.
    void this.persistSessionHandle(sessionId, session)
      .catch(() => undefined)
      .then(() => {
        const ended: ClaudeStructuredSessionEvent = {
          type: 'ended',
          sessionId,
          reason: error.message,
          cause: 'unexpected-exit',
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration
        }
        this.emit(session, session.events, ended)
        settleClaudeExitedSession(session)
      })
  }

  private async persistSessionHandle(sessionId: string, session: ClaudeSession): Promise<void> {
    try {
      const transcriptLeaf = this.deps.readTranscriptLeaf
        ? await readClaudeTranscriptLeafWithReproof({
            readTranscriptLeaf: this.deps.readTranscriptLeaf,
            providerSessionId: session.providerSessionId,
            previousLeafUuid: session.leafUuid
          })
        : null
      if (transcriptLeaf) {
        session.leafUuid = transcriptLeaf
      }
    } catch {
      // A stale or unavailable tail must not overwrite the last observed leaf.
    }
    await this.deps.persistHandle?.({
      sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid: session.leafUuid,
      fence: session.fence
    })
  }

  private emit(
    _session: ClaudeSession | null,
    _events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ): void {
    _session?.translator?.handle(event)
    this.deps.onEvent?.(event)
  }

  bindPromptItemId(
    sessionId: string,
    journalItemId: string,
    promptKey: string,
    questionId?: string
  ): void {
    this.sessions.get(sessionId)?.prompts.bindJournalItemId(journalItemId, promptKey, questionId)
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    dispatchClaudeTurn(
      this.session(input.sessionId),
      input,
      this.deps.dispatchAckTimeoutMs ?? DISPATCH_ACK_TIMEOUT_MS
    )

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) => {
    const session = this.session(input.sessionId)
    const acquisitionGeneration = session.acquisitionGeneration
    return cancelClaudeTurn(session, this.deps.requestTimeoutMs, () => {
      // Keep every ownership check adjacent to the provider interrupt. The
      // session map check fences a replaced child; the turn check fences a
      // delayed cancel after a newer turn was admitted on the same child.
      return (
        this.sessions.get(input.sessionId) === session &&
        session.fence === input.fence &&
        session.acquisitionGeneration === acquisitionGeneration &&
        (session.activeTurnId === undefined
          ? session.dispatchSequence === 0
          : session.activeTurnId === input.turnId &&
            session.activeTurnSequence === session.dispatchSequence)
      )
    })
  }
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    answerClaudePrompt(this.session(input.sessionId), input)
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    setClaudeStructuredOption(this.session(input.sessionId), input, this.deps.requestTimeoutMs)
  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    releaseClaudeAcquisition({
      sessionId: input.sessionId,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })

  closeSession = (sessionId: string): Promise<boolean> =>
    closeClaudeSession({
      sessionId,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.readTranscriptLeaf ? { readTranscriptLeaf: this.deps.readTranscriptLeaf } : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })

  closeAll = (): Promise<void> =>
    closeAllClaudeSessions({
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      closeSession: this.closeSession
    })

  private session(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`no live claude stream-json session for ${sessionId}`)
    }
    return session
  }
}
