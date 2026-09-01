import { useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import { useVisibleTerminalQuickCommands } from '@/hooks/use-visible-terminal-quick-commands'
import { useAppStore } from '../../store'
import {
  NEW_TAB_MENU_QUICK_COMMAND_LIMIT,
  selectNewTabMenuQuickCommands
} from './quick-command-launch-options'
import { EMPTY_QUICK_COMMAND_OPTIONS } from './tab-create-entry-empty-options'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

export type TabBarMenuQuickCommands = {
  /** Every quick command the omnibox can filter, most recent first. */
  quickCommandOptions: readonly HostedTerminalQuickCommand[]
  /** The short list the unfiltered menu shows below the agents. */
  menuQuickCommands: readonly HostedTerminalQuickCommand[]
  runQuickCommand: (entry: HostedTerminalQuickCommand) => void
}

/**
 * Quick commands for the "+" menu. Radix unmounts the menu body while it is
 * closed, so this normally does not run at all; the `menuOpen` gate keeps it
 * free for callers that render menu content eagerly anyway, which is why
 * `TabBarCreateEntry` gates its own store reads the same way.
 */
export function useTabBarMenuQuickCommands({
  menuOpen,
  onQueueTerminalFocus,
  resolvedGroupId,
  worktreeId
}: {
  menuOpen: boolean
  onQueueTerminalFocus: (tabId: string) => void
  resolvedGroupId: string
  worktreeId: string
}): TabBarMenuQuickCommands {
  const recentQuickCommandId = useAppStore((state) =>
    menuOpen ? (state.recentQuickCommandIdByGroup[resolvedGroupId] ?? null) : null
  )
  const { globalCommands, repoCommands, repoId } = useVisibleTerminalQuickCommands(
    worktreeId,
    menuOpen
  )
  // Why repoId-gated: matches the tab-bar Run button, which hides itself in
  // folder workspaces and floating terminals that have no repo run target.
  const quickCommandOptions = useMemo(
    () =>
      repoId
        ? selectNewTabMenuQuickCommands(
            repoCommands,
            globalCommands,
            recentQuickCommandId,
            repoCommands.length + globalCommands.length
          )
        : EMPTY_QUICK_COMMAND_OPTIONS,
    [globalCommands, recentQuickCommandId, repoCommands, repoId]
  )
  const menuQuickCommands = useMemo(
    () => quickCommandOptions.slice(0, NEW_TAB_MENU_QUICK_COMMAND_LIMIT),
    [quickCommandOptions]
  )
  const runQuickCommand = (entry: HostedTerminalQuickCommand): void => {
    const result = runQuickCommandInNewTab({
      command: entry.command,
      worktreeId,
      groupId: resolvedGroupId,
      historyId: entry.key
    })
    if (!result) {
      toast.error(
        translate(
          'auto.components.tab.bar.TabBar.quickCommandLaunchFailed',
          'Could not run "{{value0}}".',
          { value0: entry.command.label }
        )
      )
      return
    }
    onQueueTerminalFocus(result.tabId)
  }

  return { quickCommandOptions, menuQuickCommands, runQuickCommand }
}
