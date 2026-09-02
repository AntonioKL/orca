import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import type { ClaudeSession } from './claude-structured-session-state'

const OPTION_ORDER = ['model', 'effort', 'permissionMode'] as const

export function restoredClaudeStructuredSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(
    OPTION_ORDER.flatMap((key) => {
      const value = options?.[key]
      return value ? [[key, value] as const] : []
    })
  )
}

export async function setClaudeStructuredOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  const apply =
    input.key === 'model'
      ? () => session.connection.setModel(input.value, { timeoutMs })
      : input.key === 'permissionMode'
        ? () => session.connection.setPermissionMode(input.value as PermissionMode, { timeoutMs })
        : input.key === 'effort'
          ? () =>
              session.connection.applyFlagSettings(
                { effortLevel: input.value as EffortLevel },
                { timeoutMs }
              )
          : null
  if (!apply) {
    throw new AgentSessionOptionRejectedError(
      `claude stream-json has no session option named ${input.key}`
    )
  }
  try {
    await apply()
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  }
  session.options.set(input.key, input.value)
  return Object.fromEntries(session.options)
}

export async function restoreClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  const options = [...session.options.entries()]
  session.options.clear()
  for (const [key, value] of options) {
    await setClaudeStructuredOption(session, { key, value }, timeoutMs)
  }
}
