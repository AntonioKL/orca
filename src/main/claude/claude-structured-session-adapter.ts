import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  AgentSessionPreSpawnError as PreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup as rethrowAfterCleanup
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { answerClaudePrompt, cancelClaudeTurn } from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { claudeAuthDiagnostic, readClaudeModels } from './claude-structured-init-proof'
import {
  createClaudeInitDeadline,
  requestClaudeInitialization
} from './claude-structured-init-deadline'
import { CLAUDE_SPAWN_TOKEN_ENV, claudeProcessIdentity } from './claude-structured-owner-identity'
import { ClaudeStructuredAcquisitionEvents } from './claude-structured-acquisition-events'
import {
  restoreClaudeStructuredSessionOptions,
  restoredClaudeStructuredSessionOptions,
  setClaudeStructuredOption
} from './claude-structured-options'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import { createClaudeSessionJournalTranslator } from './claude-structured-journal-translation'
import { ClaudeStructuredProviderEvents } from './claude-structured-provider-events'
import {
  cancelClaudeAcquisitionAttempt,
  ClaudeAcquisitionRegistry,
  mintClaudeAcquisitionGeneration,
  type ClaudeSession,
  type ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import { closeClaudePublishedSession } from './claude-structured-session-close'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'

export type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
export type {
  ClaudeAuthDiagnostic,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export const CLAUDE_STRUCTURED_INIT_TIMEOUT_MS = 10_000
const DISPATCH_ACK_TIMEOUT_MS = 10_000

export class ClaudeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly acquisitions = new ClaudeAcquisitionRegistry()
  private readonly events: ClaudeStructuredProviderEvents

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {
    this.events = new ClaudeStructuredProviderEvents(this.sessions, deps.onEvent)
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    agent === 'claude' &&
    location.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    location.wslDistro === null &&
    (process.platform === 'darwin' || process.platform === 'linux')

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    this.supportsCreate(location, 'claude')

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const prompts = new ClaudePromptRegistry()
    const translator = createClaudeSessionJournalTranslator(input.events, prompts)
    const { previous, attempt } = this.acquisitions.start(sessionId, prompts)
    const initTimeoutMs = this.deps.initTimeoutMs ?? CLAUDE_STRUCTURED_INIT_TIMEOUT_MS
    const initDeadline = createClaudeInitDeadline(sessionId, initTimeoutMs)
    const acquisitionEvents = new ClaudeStructuredAcquisitionEvents(
      sessionId,
      attempt,
      input.events,
      initDeadline,
      this.events
    )

    try {
      if (!(await cancelClaudeAcquisitionAttempt(previous))) {
        throw new Error(`superseded claude session ${sessionId} did not prove provider exit`)
      }
      this.acquisitions.assertCurrent(sessionId, attempt)
      await this.closePublishedSession(sessionId)
      this.acquisitions.assertCurrent(sessionId, attempt)
      const launch = await this.deps
        .resolveLaunch({ identity: input.identity })
        .catch((error: unknown) => {
          throw new PreSpawnError(error)
        })
      acquisitionEvents.observeResumeLeaf(launch.resumeLeafUuid)
      this.acquisitions.assertCurrent(sessionId, attempt)
      const open = this.deps.openConnection ?? openClaudeStreamJsonConnection
      const connection = await open(
        {
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: {
            ...launch.env,
            [CLAUDE_SPAWN_TOKEN_ENV]: input.spawnToken,
            CLAUDE_CONFIG_DIR: launch.claudeConfigDir
          }
        },
        {
          onMessage: acquisitionEvents.onMessage,
          onControlRequest: acquisitionEvents.onControlRequest,
          onControlCancelRequest: acquisitionEvents.onControlCancelRequest,
          onExit: (error) => {
            if (!attempt.published) {
              initDeadline.reject(error)
            }
            this.events.handleExit(sessionId, attempt, error)
          }
        }
      )
      attempt.connection = connection
      this.acquisitions.assertCurrent(sessionId, attempt)
      initDeadline.start()
      const [initialization, init] = await Promise.all([
        requestClaudeInitialization(connection, sessionId, initTimeoutMs),
        initDeadline.promise
      ])
      const models = readClaudeModels(initialization)
      acquisitionEvents.emit({ type: 'options', sessionId, models })
      initDeadline.clear()
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (init.providerSessionId !== launch.providerSessionId) {
        throw new Error(
          `claude proved session ${init.providerSessionId}, expected ${launch.providerSessionId}`
        )
      }
      const settings = await connection
        .request('get_settings', {}, { timeoutMs: this.deps.requestTimeoutMs })
        .catch(() => null)
      acquisitionEvents.emit({
        type: 'auth-diagnostic',
        sessionId,
        diagnostic: claudeAuthDiagnostic(init, settings)
      })
      const process = await claudeProcessIdentity(
        { ...input, pid: connection.pid },
        this.deps.readProcessStartTime
      )
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (connection.closed) {
        throw new Error(`claude stream-json for session ${sessionId} exited while being acquired`)
      }
      const publication = createClaudeSessionPublication({
        connection,
        init,
        leafUuid: acquisitionEvents.observedLeaf(),
        fence: input.fence,
        resumed: launch.resumed,
        prompts,
        translator,
        events: input.events,
        process,
        options: restoredClaudeStructuredSessionOptions(input.options),
        ...(this.deps.mintLinkId ? { linkId: this.deps.mintLinkId() } : {}),
        observedAt: this.deps.now?.() ?? Date.now(),
        acquisitionGeneration: mintClaudeAcquisitionGeneration(this.deps)
      })
      const acquired: AgentSessionAcquisition = publication.acquisition
      const liveSession = publication.session
      acquisitionEvents.publish(liveSession)
      await restoreClaudeStructuredSessionOptions(liveSession, this.deps.requestTimeoutMs)
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (attempt.exitProven || connection.closed) {
        throw new Error(`claude stream-json for session ${sessionId} exited while being acquired`)
      }
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      this.sessions.set(sessionId, liveSession)
      attempt.published = true
      for (const event of attempt.buffered.splice(0)) {
        event()
      }
      return acquired
    } catch (error) {
      initDeadline.clear()
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      if (this.sessions.get(sessionId)?.connection !== attempt.connection) {
        translator?.dispose()
        prompts.clear()
        await rethrowAfterCleanup(
          {
            releaseAcquisition: async () =>
              attempt.connection ? await attempt.connection.close() : true
          },
          sessionId,
          error
        )
      }
      throw error
    } finally {
      attempt.finish()
    }
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

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    cancelClaudeTurn(this.session(input.sessionId), this.deps.requestTimeoutMs)

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    answerClaudePrompt(this.session(input.sessionId), input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    setClaudeStructuredOption(this.session(input.sessionId), input, this.deps.requestTimeoutMs)

  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.closeSession(input.sessionId)
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const attempt = this.acquisitions.get(sessionId)
    if (attempt) {
      attempt.cancelled = true
      const exited = attempt.connection ? await attempt.connection.close() : true
      await attempt.finished
      if (!exited) {
        return false
      }
    }
    return this.closePublishedSession(sessionId)
  }

  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)

  private closePublishedSession(sessionId: string): Promise<boolean> {
    return closeClaudePublishedSession({
      sessions: this.sessions,
      sessionId,
      providerEvents: this.events,
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })
  }

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    closeClaudePublishedSession({
      sessions: this.sessions,
      sessionId,
      providerEvents: this.events,
      requestedClose: false,
      allowFailedSettlement: true
    })

  async closeAll(): Promise<void> {
    this.acquisitions.close()
    await closeProcessRegistry({
      attempts: 3,
      hasEntries: () => this.sessions.size > 0 || this.acquisitions.size > 0,
      entryIds: () => new Set([...this.sessions.keys(), ...this.acquisitions.sessionIds()]),
      closeEntry: (sessionId) => this.closeSession(sessionId),
      failureMessage: 'claude structured session teardown could not prove provider-child exit'
    })
  }

  private session(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      throw new Error(`no live claude stream-json session for ${sessionId}`)
    }
    return session
  }
}
