import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'
import { killCodexAppServerProcessTree } from '../codex/codex-app-server-session'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { createClaudeAgentSdkControlBridge } from './claude-agent-sdk-control-bridge'
import {
  CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS,
  ClaudeControlRequestError,
  requestClaudeControl
} from './claude-agent-sdk-control-requests'
import { proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { createClaudeUserMessageQueue } from './claude-agent-sdk-user-message-queue'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'

export { ClaudeControlRequestError }

/**
 * The SDK is loaded at the structured-Claude boundary rather than by this module's
 * import. The ordinary runtime's class graph statically reaches this file, and the
 * SDK sets `process.env.NoDefaultCurrentDirectoryInExePath` at import time — a
 * Windows executable-search change that a user who never leaves the terminal/TUI
 * path never opted into, and a missing SDK would fail runtime startup. Memoized,
 * so a session pays the import once per process rather than once per connection.
 */
let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  claudeAgentSdk ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeAgentSdk
}

export type ClaudeStreamJsonLaunch = {
  /** Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed. */
  pathToClaudeCodeExecutable: string
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
}

export type ClaudeControlRequest = {
  type: 'control_request'
  request_id: string
  request: Record<string, unknown> & { subtype: string }
}

export type ClaudeControlCancelRequest = {
  type: 'control_cancel_request'
  request_id: string
}

export type ClaudeControlResponder = Pick<
  ClaudeStreamJsonConnection,
  'respond' | 'respondWithError'
>

export type ClaudeStreamJsonConnectionHandlers = {
  onMessage?: (message: Record<string, unknown>) => void
  onControlRequest?: (request: ClaudeControlRequest, responder?: ClaudeControlResponder) => void
  onControlCancelRequest?: (request: ClaudeControlCancelRequest) => void
  onExit?: (error: Error) => void
}

export type ClaudeStreamJsonConnection = {
  readonly pid: number | undefined
  readonly closed: boolean
  send: (message: Record<string, unknown>) => Promise<void>
  request: (
    subtype: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>
  respond: (requestId: string, response: unknown) => Promise<void>
  respondWithError: (requestId: string, error: string) => Promise<void>
  /** Resolves true only after the child emitted exit/close; false is unproven. */
  close: () => Promise<boolean>
}

function exitError(stderrTail: string, cause?: Error): Error {
  const detail = stderrTail.trim()
  const message = detail ? `claude stream-json exited: ${detail}` : 'claude stream-json exited'
  return cause ? new Error(message, { cause }) : new Error(message)
}

export async function openClaudeStreamJsonConnection(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess
): Promise<ClaudeStreamJsonConnection> {
  const { query } = await loadClaudeAgentSdk()
  const spawner = createClaudeCodeProcessSpawn(spawnImpl)
  const bridge = createClaudeAgentSdkControlBridge(handlers)
  const inbox = createClaudeUserMessageQueue()
  const session = query({
    prompt: inbox.messages,
    options: {
      ...launch.options,
      cwd: launch.cwd,
      // Why env is never omitted: the SDK inherits process.env when it is, which is
      // exactly the ambient ANTHROPIC_* auth leak this lane already shipped once.
      env: buildClaudeChildProcessEnv(launch.env),
      pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: spawner.spawn,
      canUseTool: bridge.canUseTool,
      onUserDialog: bridge.onUserDialog
    }
  })
  const child = spawner.child
  if (!child) {
    throw new Error('the claude agent SDK returned without spawning a child')
  }

  let exited = false
  let closing = false
  let terminalError: Error | null = null
  let closePromise: Promise<boolean> | null = null

  let settleExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    settleExit = resolve
  })
  const markExited = (): void => {
    exited = true
    settleExit()
  }
  child.on('exit', markExited)

  const handleUnexpectedEnd = (cause?: Error): void => {
    if (terminalError) {
      return
    }
    terminalError = exitError(spawner.stderrTail, cause)
    inbox.fail(terminalError)
    if (!closing) {
      handlers.onExit?.(terminalError)
    }
  }

  void (async () => {
    for await (const message of session) {
      handlers.onMessage?.(message as unknown as Record<string, unknown>)
    }
  })().catch((error: unknown) => {
    // The SDK ends its generator in error when the child dies or the transport
    // fails; a transport failure with a live child still has to reap the tree.
    if (!closing && !exited) {
      killCodexAppServerProcessTree(child)
    }
    handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
  })

  child.on('error', (error) => {
    markExited()
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    markExited()
    handleUnexpectedEnd()
  })
  child.stdin.on('error', (error) => {
    if (!closing) {
      killCodexAppServerProcessTree(child)
      handleUnexpectedEnd(error)
    }
  })

  const send = (message: Record<string, unknown>): Promise<void> => {
    if (closing || exited || terminalError || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(terminalError ?? new Error('claude stream-json connection is closed'))
    }
    return inbox.push(message as unknown as SDKUserMessage)
  }

  const close = (): Promise<boolean> => {
    closePromise ??= (async () => {
      closing = true
      bridge.stopCancelling()
      inbox.end()
      const proven = await proveClaudeChildExit({
        child,
        exitPromise,
        exited: () => exited
      })
      inbox.fail(new Error('claude stream-json connection closed'))
      if (!proven) {
        closePromise = null
      }
      return proven
    })()
    return closePromise
  }

  return {
    get pid() {
      return spawner.pid
    },
    get closed() {
      return closing || exited || terminalError !== null
    },
    send,
    request: (subtype, params = {}, options = {}) =>
      requestClaudeControl(
        session,
        subtype,
        params,
        options.timeoutMs ?? CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS
      ),
    respond: bridge.respond,
    respondWithError: bridge.respondWithError,
    close
  }
}
