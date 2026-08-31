import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
  type StructuredAgentSessionCommandOutcome
} from '../../../src/shared/structured-agent-session-composer'
import { getVerifiedNativeChatCommands } from '../../../src/shared/native-chat-agent-profiles'
import type { SlashCommandSuggestion } from '../../../src/shared/native-chat-slash-commands'
import type { MobileStructuredAgent } from './mobile-structured-session-create'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

export const MOBILE_STRUCTURED_SLASH_COMMANDS = STRUCTURED_AGENT_SESSION_SLASH_COMMANDS
export type MobileStructuredCommandOutcome = StructuredAgentSessionCommandOutcome

const STRUCTURED_COMMAND_PREFIX: readonly SlashCommandSuggestion[] = [
  { name: 'model', description: 'Choose the model and reasoning effort' },
  { name: 'effort', description: 'Choose reasoning effort' }
]

export function mobileStructuredSlashCommands(
  agent: MobileStructuredAgent
): readonly SlashCommandSuggestion[] {
  return agent === 'codex'
    ? STRUCTURED_AGENT_SESSION_SLASH_COMMANDS
    : [...STRUCTURED_COMMAND_PREFIX, ...getVerifiedNativeChatCommands(agent)]
}

export function isMobileStructuredComposerCommand(
  text: string,
  agent: MobileStructuredAgent
): boolean {
  return isStructuredAgentSessionComposerCommand(text, agent)
}

export function dispatchMobileStructuredComposerCommand(
  text: string,
  controller: MobileNativeChatSessionOptionsController,
  agent: MobileStructuredAgent
): Promise<MobileStructuredCommandOutcome> {
  return dispatchStructuredAgentSessionComposerCommand(text, { ...controller, agent })
}
