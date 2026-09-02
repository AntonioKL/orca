import type { PermissionMode, Query } from '@anthropic-ai/claude-agent-sdk'

export class ClaudeControlRequestError extends Error {
  constructor(
    readonly subtype: string,
    message: string
  ) {
    super(message)
    this.name = 'ClaudeControlRequestError'
  }
}

export const CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** The SDK closes a query out from under an in-flight control request with this exact message. */
const QUERY_CLOSED_MESSAGE = 'Query closed before response received'

/** 0.3.251 ships getSettings() but redacts it from the Query declaration; the typeof guard below is its degradation path. */
type ClaudeQuerySettingsReader = { getSettings?: () => Promise<unknown> }

export function claudeQuerySettingsReader(query: Query): (() => Promise<unknown>) | null {
  const reader = (query as unknown as ClaudeQuerySettingsReader).getSettings
  return typeof reader === 'function' ? reader.bind(query) : null
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function sendControlRequest(
  query: Query,
  subtype: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (subtype) {
    case 'initialize':
      return query.initializationResult()
    case 'get_settings': {
      const read = claudeQuerySettingsReader(query)
      return read
        ? read()
        : Promise.reject(
            new ClaudeControlRequestError(subtype, 'this SDK exposes no get_settings request')
          )
    }
    case 'set_model':
      return query.setModel(readString(params, 'model')).then(() => ({}))
    case 'set_permission_mode':
      return query.setPermissionMode(readString(params, 'mode') as PermissionMode).then(() => ({}))
    case 'apply_flag_settings':
      return query
        .applyFlagSettings((params.settings ?? {}) as Parameters<Query['applyFlagSettings']>[0])
        .then(() => ({}))
    case 'interrupt':
      return query.interrupt().then((receipt) => receipt ?? {})
    default:
      return Promise.reject(
        new ClaudeControlRequestError(subtype, `claude ${subtype} is not an SDK control request`)
      )
  }
}

/**
 * Issue one of the control requests this transport used to frame by hand.
 *
 * The SDK owns correlation but applies no deadline, so the timeout stays here —
 * and its message is load-bearing: the init proof matches on it.
 */
export function requestClaudeControl(
  query: Query,
  subtype: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`claude ${subtype} request timed out`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([
    sendControlRequest(query, subtype, params).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // A closed query is a transport failure, not the CLI rejecting the option:
      // only the latter may surface as a rejected session option.
      if (error instanceof ClaudeControlRequestError || message === QUERY_CLOSED_MESSAGE) {
        throw error
      }
      throw new ClaudeControlRequestError(subtype, message)
    }),
    deadline
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}
