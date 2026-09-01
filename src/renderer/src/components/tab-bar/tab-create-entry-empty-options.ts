import type { OpenTabSearchResult } from './open-tab-search'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

export const EMPTY_AGENT_OPTIONS: readonly TabAgentLaunchOption[] = []
export const EMPTY_MENU_OPTIONS: readonly TabCreateMenuOption[] = []
export const EMPTY_TAB_RESULTS: readonly OpenTabSearchResult[] = []
export const EMPTY_QUICK_COMMAND_OPTIONS: readonly HostedTerminalQuickCommand[] = []
