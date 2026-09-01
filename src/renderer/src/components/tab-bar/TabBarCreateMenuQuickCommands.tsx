import React from 'react'
import { Play } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

/** The unfiltered new-tab menu's quick-command section, below the agent list. */
export function TabBarCreateMenuQuickCommands({
  entries,
  onRun
}: {
  entries: readonly HostedTerminalQuickCommand[]
  onRun: (entry: HostedTerminalQuickCommand) => void
}): React.JSX.Element {
  return (
    <>
      <DropdownMenuLabel>
        {translate('auto.components.tab.bar.TabBar.quickCommandsSection', 'Quick Commands')}
      </DropdownMenuLabel>
      {entries.map((entry) => (
        <DropdownMenuItem
          key={entry.key}
          onSelect={() => onRun(entry)}
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
          title={getTerminalQuickCommandBody(entry.command)}
        >
          {isTerminalAgentQuickCommand(entry.command) ? (
            <AgentIcon agent={entry.command.agent} size={14} />
          ) : (
            <Play className="size-4 text-muted-foreground" fill="currentColor" strokeWidth={0} />
          )}
          <span className="flex-1 truncate">{entry.command.label}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
