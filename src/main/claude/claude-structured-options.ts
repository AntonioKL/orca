import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  AgentSessionOptionRejectedError,
  isAgentSessionOptionRejectedError
} from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { readClaudeSettingsEffort } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

const OPTION_ORDER = ['model', 'effort', 'permissionMode'] as const

/**
 * Efforts the settings readback cannot report. `max` applies for the rest of the
 * session and is excluded from the persisted `effortLevel` by contract, so
 * `get_settings` answers with the level underneath it — an absence of evidence
 * that must not be read as the child refusing a level its own catalog offers.
 */
const UNREPORTED_EFFORTS: ReadonlySet<string> = new Set(['max'])

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
  const mutationSequence = ++session.optionMutationSequence
  try {
    await apply()
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  }
  // apply_flag_settings answers `success` for an effort it then ignores, so the
  // absence of a throw proves nothing. Ask what the child actually holds.
  const adopted =
    input.key === 'effort' && !UNREPORTED_EFFORTS.has(input.value)
      ? await session.connection
          .getSettings({ timeoutMs })
          .then(readClaudeSettingsEffort)
          .catch(() => null)
      : null
  if (mutationSequence !== session.optionMutationSequence) {
    return Object.fromEntries(session.options)
  }
  // A readback that could not be taken is not evidence of a refusal; one that
  // disagrees is, and recording it anyway would show an effort nothing adopted.
  if (adopted !== null && adopted !== input.value) {
    throw new AgentSessionOptionRejectedError(
      `claude kept effort ${adopted} instead of ${input.value}`
    )
  }
  session.options.set(input.key, input.value)
  return Object.fromEntries(session.options)
}

export async function restoreClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> {
  // Any write that was already in flight belongs to the previous acquisition
  // state and must not repopulate this map after restore starts.
  session.optionMutationSequence += 1
  const options = [...session.options.entries()]
  session.options.clear()
  for (const [key, value] of options) {
    try {
      await setClaudeStructuredOption(session, { key, value }, timeoutMs)
    } catch (error) {
      if (!isAgentSessionOptionRejectedError(error)) {
        throw error
      }
      // A stale or unavailable preference must not poison every future acquire;
      // the provider's current value remains authoritative and is re-persisted.
      session.restoreSkippedOptions.add(key)
    }
  }
}
