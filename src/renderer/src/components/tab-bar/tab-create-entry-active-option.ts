import type { TabEntryActionClassification, TabEntryOption } from './tab-create-entry-action'
import type { OpenTabSearchResult } from './open-tab-search'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

export type ActiveEntryOption = TabEntryOption & {
  classification: TabEntryActionClassification
}

// A row the user can act on in the new-tab open entry: an open tab to switch
// to, a create-menu action, a matched agent to launch, a saved quick command to
// run, or a file/URL entry.
export type ActiveOption =
  | {
      kind: 'agent'
      option: TabAgentLaunchOption
    }
  | {
      kind: 'tab'
      option: OpenTabSearchResult
    }
  | {
      kind: 'entry'
      option: ActiveEntryOption
    }
  | {
      kind: 'menu'
      option: TabCreateMenuOption
    }
  | {
      kind: 'quick-command'
      option: HostedTerminalQuickCommand
    }

export function isActiveEntryOption(option: TabEntryOption): option is ActiveEntryOption {
  return option.classification.kind !== 'empty' && option.classification.kind !== 'blocked'
}

export function getActiveOptionId(option: ActiveOption): string {
  if (option.kind === 'agent') {
    return `agent:${option.option.agent}`
  }
  if (option.kind === 'menu') {
    return `menu:${option.option.id}`
  }
  if (option.kind === 'quick-command') {
    return `quick-command:${option.option.key}`
  }
  // Tab result ids are already `open-tab:`-prefixed and stable across renders.
  return option.option.id
}
