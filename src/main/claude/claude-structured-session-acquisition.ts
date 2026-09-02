import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'
import { resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import {
  claudeAuthDiagnostic,
  readClaudeCapabilities,
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
  mintClaudeAcquisitionGeneration,
  type ClaudeAcquisitionRegistry,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import {
  closeClaudePublishedSessionForDeps,
  closeClaudeSession
} from './claude-structured-session-close'
import { readClaudeTranscriptEntryUuid } from './claude-tui-exit'

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

/**
 * Which failure a Claude child that would not close cleanly actually is.
 *
 * The lease is keyed on the root's pid and start time, so a first-hand root exit
 * releases it and the CLI's own diagnostic reaches the user. A descendant seen
 * still alive, or a root Orca never saw leave, stays unproven and keeps the
 * reservation — releasing there is the orphaning this proof exists to prevent.
 */
function claudeAcquisitionCleanupError(
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

export async function acquireClaudeSession({
  input,
  deps,
  sessions,
  acquisitions,
  exits,
  callbacks
}: {
  input: StructuredAgentSessionAcquireInput
  deps: ClaudeStructuredSessionAdapterDeps
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
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
    observedLeafUuid = readClaudeTranscriptEntryUuid(message) ?? observedLeafUuid
    if (liveSession) {
      liveSession.leafUuid = observedLeafUuid
    }
    const startsTurn = liveSession ? resolveClaudeReplayWaiter(liveSession, message) : false
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, {
        type: 'message',
        sessionId,
        message,
        ...(startsTurn ? { startsTurn: true } : {})
      })
    )
  }
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({
    sessionId,
    prompts,
    emit: (event) =>
      callbacks.deliver(attempt, sessionId, () => callbacks.emit(liveSession, input.events, event))
  })

  try {
    if (previous && !(await cancelClaudeAcquisitionAttempt(previous))) {
      acquisitions.restoreIfCurrent(sessionId, attempt, previous)
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude acquisition for session ${sessionId} could not be stopped`)
      )
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const priorSession = sessions.get(sessionId)
    if (
      !(await closeClaudePublishedSessionForDeps(sessions, sessionId, {
        ...(deps.persistHandle ? { persistHandle: deps.persistHandle } : {}),
        ...(deps.readTranscriptLeaf ? { readTranscriptLeaf: deps.readTranscriptLeaf } : {}),
        ...(deps.onEvent ? { onEvent: deps.onEvent } : {})
      }))
    ) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`claude session ${sessionId} could not be stopped`)
      )
    }
    // Any earlier session is closed or already gone: its exit says nothing about this start.
    exits.delete(sessionId)
    acquisitions.assertCurrent(sessionId, attempt)
    // Closing persists the prior connection's final leaf, so launch validates that durable head.
    const launchIdentity = priorSession
      ? {
          ...input.identity,
          providerHandle: {
            kind: 'claude' as const,
            sessionId: priorSession.providerSessionId,
            leafUuid: priorSession.leafUuid
          }
        }
      : input.identity
    const launch = await deps
      .resolveLaunch({ identity: launchIdentity })
      .catch((error: unknown) => {
        throw error instanceof AgentSessionPreSpawnError
          ? error
          : new AgentSessionPreSpawnError(error)
      })
    observedLeafUuid = launch.resumeLeafUuid
    acquisitions.assertCurrent(sessionId, attempt)
    const open = deps.openConnection ?? openClaudeStreamJsonConnection
    const connection = await open(
      {
        pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
        options: launch.options,
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
        canUseTool,
        onUserDialog,
        onFault: (error) => {
          if (!attempt.published) {
            initDeadline.reject(error)
          }
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
      .getSettings({ timeoutMs: deps.requestTimeoutMs })
      .catch(() => null)
    callbacks.deliver(attempt, sessionId, () =>
      callbacks.emit(liveSession, input.events, {
        type: 'auth-diagnostic',
        sessionId,
        diagnostic: claudeAuthDiagnostic(init, settings)
      })
    )
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
      acquisitionGeneration: mintClaudeAcquisitionGeneration(deps),
      options: restoredClaudeStructuredSessionOptions(input.options),
      capabilities: readClaudeCapabilities(init, initialization),
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
    let acquisitionError = error
    if (sessions.get(sessionId)?.connection !== attempt.connection) {
      translator?.dispose()
      // Settle any callback that fired before the failure so no SDK promise dangles.
      for (const prompt of prompts.clear()) {
        prompt.settle(null)
      }
      const closed = (await attempt.connection?.close()) ?? true
      if (attempt.connection?.exitVerdict.root === 'processless') {
        acquisitionError = new AgentSessionPreSpawnError(error)
      } else if (!closed) {
        acquisitionError = claudeAcquisitionCleanupError(attempt.connection, error)
      }
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw acquisitionError
  } finally {
    attempt.finish()
  }
}

/**
 * Cleanup for an acquisition the host could not commit or prove. A session that
 * a first-hand exit already removed is not an absence to report as proven: the
 * ladder on its connection still answers, and that answer is classified exactly
 * as a start-time failure would be.
 */
export async function releaseClaudeAcquisition(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  persistHandle?: ClaudeStructuredSessionAdapterDeps['persistHandle']
  onEvent?: ClaudeStructuredSessionAdapterDeps['onEvent']
}): Promise<boolean> {
  const exit = input.exits.get(input.sessionId)
  if (!exit || input.sessions.has(input.sessionId) || input.acquisitions.get(input.sessionId)) {
    return closeClaudeSession(input)
  }
  if (await exit.connection.close()) {
    // Keep the first-hand exit evidence indexed until the tree proof succeeds;
    // a failed close must be retryable and cannot look like an absent session.
    input.exits.delete(input.sessionId)
    return true
  }
  throw claudeAcquisitionCleanupError(exit.connection, exit.error)
}
