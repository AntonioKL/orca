import { AgentSessionAcquisitionExitUnprovenError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  openClaudeStreamJsonConnection,
  type ClaudeControlRequest,
  type ClaudeControlResponder
} from './claude-stream-json-connection'
import {
  handleClaudeInboundControl,
  handleClaudeInboundControlCancel
} from './claude-structured-inbound-control'
import { resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import {
  claudeAuthDiagnostic,
  readClaudeFrameString,
  readClaudeInit,
  readClaudeModels
} from './claude-structured-init-proof'
import {
  createClaudeInitDeadline,
  requestClaudeInitialization
} from './claude-structured-init-deadline'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { CLAUDE_SPAWN_TOKEN_ENV, claudeProcessIdentity } from './claude-structured-owner-identity'
import {
  restoreClaudeStructuredSessionOptions,
  restoredClaudeStructuredSessionOptions
} from './claude-structured-options'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { createClaudeSessionJournalTranslator } from './claude-structured-journal-translation'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import {
  cancelClaudeAcquisitionAttempt,
  type ClaudeAcquisitionRegistry,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { closeClaudePublishedSessionForDeps } from './claude-structured-session-close'

export const CLAUDE_STRUCTURED_INIT_TIMEOUT_MS = 10_000

type AcquireCallbacks = {
  deliver: (attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void) => void
  emit: (
    session: ClaudeSession | null,
    events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ) => void
  handleExit: (sessionId: string, attempt: ClaudeAcquisitionAttempt, error: Error) => void
}

export async function acquireClaudeSession({
  input,
  deps,
  sessions,
  acquisitions,
  callbacks
}: {
  input: StructuredAgentSessionAcquireInput
  deps: ClaudeStructuredSessionAdapterDeps
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  callbacks: AcquireCallbacks
}): Promise<AgentSessionAcquisition> {
  const sessionId = input.identity.sessionId
  const prompts = new ClaudePromptRegistry()
  const translator = createClaudeSessionJournalTranslator(
    input.events,
    prompts,
    String(input.fence)
  )
  const { previous, attempt } = acquisitions.start(sessionId, prompts)
  let liveSession: ClaudeSession | null = null
  let observedLeafUuid: string | null = null
  const initTimeoutMs = deps.initTimeoutMs ?? CLAUDE_STRUCTURED_INIT_TIMEOUT_MS
  const initDeadline = createClaudeInitDeadline(sessionId, initTimeoutMs)

  const onMessage = (message: Record<string, unknown>): void => {
    const init = readClaudeInit(message)
    if (init) {
      initDeadline.resolve(init)
    }
    observedLeafUuid = readClaudeFrameString(message, 'uuid') ?? observedLeafUuid
    if (liveSession) {
      liveSession.leafUuid = observedLeafUuid
      resolveClaudeReplayWaiter(liveSession, message)
    }
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, { type: 'message', sessionId, message })
    )
  }
  const onControlRequest = (
    request: ClaudeControlRequest,
    responder?: ClaudeControlResponder
  ): void => {
    handleClaudeInboundControl({
      sessionId,
      attempt,
      request,
      responder,
      emit: (event) =>
        callbacks.deliver(attempt, sessionId, () =>
          callbacks.emit(liveSession, input.events, event)
        )
    })
  }

  try {
    if (previous && !(await cancelClaudeAcquisitionAttempt(previous))) {
      acquisitions.restoreIfCurrent(sessionId, attempt, previous)
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude acquisition for session ${sessionId} could not be stopped`)
      )
    }
    acquisitions.assertCurrent(sessionId, attempt)
    if (!(await closeClaudePublishedSessionForDeps(sessions, sessionId, deps))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude session ${sessionId} could not be stopped`)
      )
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const launch = await deps.resolveLaunch({ identity: input.identity })
    observedLeafUuid = launch.resumeLeafUuid
    acquisitions.assertCurrent(sessionId, attempt)
    const open = deps.openConnection ?? openClaudeStreamJsonConnection
    const connection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: {
          ...launch.env,
          [CLAUDE_SPAWN_TOKEN_ENV]: input.spawnToken,
          // Compared against what the child would otherwise inherit, so the record's
          // account home still wins over a diverging overlay without a needless pin.
          // (`process` is shadowed by a local later in this function, so it is not named here.)
          ...claudeConfigDirEnvPatch(launch.claudeConfigDir, launch.env ? { env: launch.env } : {})
        }
      },
      {
        onMessage,
        onControlRequest,
        onControlCancelRequest: ({ request_id: requestId }) => {
          handleClaudeInboundControlCancel({
            sessionId,
            attempt,
            requestId,
            emit: (event) =>
              callbacks.deliver(attempt, sessionId, () =>
                callbacks.emit(liveSession, input.events, event)
              )
          })
        },
        onExit: (error) => {
          if (!attempt.published) {
            initDeadline.reject(error)
          }
          callbacks.handleExit(sessionId, attempt, error)
        }
      }
    )
    attempt.connection = connection
    acquisitions.assertCurrent(sessionId, attempt)
    initDeadline.start()
    const [initialization, init] = await Promise.all([
      requestClaudeInitialization(connection, sessionId, initTimeoutMs),
      initDeadline.promise
    ])
    const models = readClaudeModels(initialization)
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, { type: 'options', sessionId, models })
    )
    initDeadline.clear()
    acquisitions.assertCurrent(sessionId, attempt)
    if (init.providerSessionId !== launch.providerSessionId) {
      throw new Error(
        `claude proved session ${init.providerSessionId}, expected ${launch.providerSessionId}`
      )
    }
    const settings = await connection
      .request('get_settings', {}, { timeoutMs: deps.requestTimeoutMs })
      .catch(() => null)
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, {
        type: 'auth-diagnostic',
        sessionId,
        diagnostic: claudeAuthDiagnostic(init, settings)
      })
    )
    observedLeafUuid = init.uuid ?? observedLeafUuid
    const process = await claudeProcessIdentity(
      { ...input, pid: connection.pid },
      deps.readProcessStartTime
    )
    acquisitions.assertCurrent(sessionId, attempt)
    if (connection.closed) {
      throw new Error(`claude stream-json for session ${sessionId} exited while being acquired`)
    }
    const publication = createClaudeSessionPublication({
      connection,
      init,
      leafUuid: observedLeafUuid,
      fence: input.fence,
      resumed: launch.resumed,
      prompts,
      translator,
      events: input.events,
      process,
      options: restoredClaudeStructuredSessionOptions(input.options),
      ...(deps.mintLinkId ? { linkId: deps.mintLinkId() } : {}),
      observedAt: deps.now?.() ?? Date.now()
    })
    const acquired: AgentSessionAcquisition = publication.acquisition
    liveSession = publication.session
    await restoreClaudeStructuredSessionOptions(liveSession, deps.requestTimeoutMs)
    acquisitions.assertCurrent(sessionId, attempt)
    acquisitions.deleteIfCurrent(sessionId, attempt)
    sessions.set(sessionId, liveSession)
    attempt.published = true
    for (const event of attempt.buffered.splice(0)) {
      event()
    }
    return acquired
  } catch (error) {
    initDeadline.clear()
    if (sessions.get(sessionId)?.connection !== attempt.connection) {
      translator?.dispose()
      prompts.clear()
      const closed = (await attempt.connection?.close()) ?? true
      if (!closed) {
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw error
  } finally {
    attempt.finish()
  }
}
