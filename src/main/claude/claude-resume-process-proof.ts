import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { tokenizeProcessCommandLine } from '../runtime/process-command-line-tokens'
import { readStructuredTuiProcessIdentity } from '../runtime/structured-tui-process-identity'

export function isClaudeResumeProcessCommandLine(
  commandLine: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const tokens = tokenizeProcessCommandLine(commandLine, platform)
  if (!tokens || !sessionId) {
    return false
  }
  return tokens.some(
    (token, index) =>
      (token === '--resume' || token === '--session-id') && tokens[index + 1] === sessionId
  )
}

type StructuredTuiIdentityInput = Parameters<typeof readStructuredTuiProcessIdentity>[0]

export async function readClaudeResumeProcessIdentity(
  input: Omit<StructuredTuiIdentityInput, 'agent' | 'processCommandMatches'> & {
    sessionId: string
  }
): Promise<AgentSessionProcessIdentity> {
  const { sessionId, ...identityInput } = input
  const platform = input.platform ?? process.platform
  const identity = await readStructuredTuiProcessIdentity({
    ...identityInput,
    agent: 'claude',
    processCommandMatches: (command) =>
      isClaudeResumeProcessCommandLine(command, sessionId, platform)
  })
  if (identity.processStartTimeMs === null) {
    throw new Error('The resumed Claude child process has no PID-reuse-safe start time.')
  }
  return identity
}
