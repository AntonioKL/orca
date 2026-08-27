import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { tokenizeProcessCommandLine } from '../runtime/process-command-line-tokens'
import { readStructuredTuiProcessIdentity } from '../runtime/structured-tui-process-identity'

export function isCodexResumeProcessCommandLine(
  commandLine: string,
  threadId: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const tokens = tokenizeProcessCommandLine(commandLine, platform)
  if (!tokens || !threadId) {
    return false
  }
  return tokens.some((token, index) => token === 'resume' && tokens[index + 1] === threadId)
}

type StructuredTuiIdentityInput = Parameters<typeof readStructuredTuiProcessIdentity>[0]

export function readCodexResumeProcessIdentity(
  input: Omit<StructuredTuiIdentityInput, 'agent' | 'processCommandMatches'> & { threadId: string }
): Promise<AgentSessionProcessIdentity> {
  const { threadId, ...identityInput } = input
  const platform = input.platform ?? process.platform
  return readStructuredTuiProcessIdentity({
    ...identityInput,
    agent: 'codex',
    processCommandMatches: (command) => isCodexResumeProcessCommandLine(command, threadId, platform)
  })
}
