import { useMemo } from 'react'
import { findMatchingTabAgentLaunchOptions } from './tab-agent-launch-options'
import { findMatchingTabCreateMenuOptions } from './tab-create-menu-options'
import { findMatchingTabQuickCommandOptions } from './quick-command-launch-options'
import { getTabEntryOptions, type TabEntryOption } from './tab-create-entry-action'
import { dropFileEntriesCoveredByTabResults } from './open-tab-entry-dedupe'
import { isActiveEntryOption, type ActiveOption } from './tab-create-entry-active-option'
import {
  EMPTY_AGENT_OPTIONS,
  EMPTY_MENU_OPTIONS,
  EMPTY_QUICK_COMMAND_OPTIONS
} from './tab-create-entry-empty-options'
import type { SearchEngine } from '../../../../shared/browser-url'
import type { RuntimeFileListState } from '../quick-open-file-list'
import type { OpenTabSearchResult } from './open-tab-search'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import type { TabCreateMenuOption } from './tab-create-menu-options'

/**
 * The rows the new-tab omnibox offers for a query, in priority order: open
 * tabs, create-menu actions, agents, saved quick commands, then file/URL
 * entries. `entryOptions` is returned alongside because the status row reads
 * the non-actionable ('empty'/'blocked') entries out of it.
 */
export function useTabCreateEntryActiveOptions({
  agentOptions,
  allowAbsolutePaths,
  fileList,
  localPlatform,
  menuOptions,
  query,
  quickCommandOptions,
  searchEngine,
  tabResults,
  terminalQueryMode,
  worktreePath
}: {
  agentOptions: readonly TabAgentLaunchOption[]
  allowAbsolutePaths: boolean
  fileList: RuntimeFileListState
  localPlatform: 'posix' | 'windows'
  menuOptions: readonly TabCreateMenuOption[]
  query: string
  quickCommandOptions: readonly HostedTerminalQuickCommand[]
  searchEngine: SearchEngine
  tabResults: readonly OpenTabSearchResult[]
  terminalQueryMode: boolean
  worktreePath: string | null
}): { activeOptions: ActiveOption[]; entryOptions: readonly TabEntryOption[] } {
  const matchingMenuOptions = useMemo(
    () =>
      terminalQueryMode ? EMPTY_MENU_OPTIONS : findMatchingTabCreateMenuOptions(query, menuOptions),
    [menuOptions, query, terminalQueryMode]
  )
  const entryOptions = useMemo(() => {
    const resolved = dropFileEntriesCoveredByTabResults(
      getTabEntryOptions(query, fileList, 4, {
        allowAbsolutePaths,
        localPlatform,
        searchEngine
      }),
      tabResults,
      worktreePath
    )
    if (matchingMenuOptions.length === 0) {
      return resolved
    }
    // Why: a matched create-menu action should win over a generic new-file fallback.
    return resolved.filter((option) => option.classification.kind !== 'new-file')
  }, [
    allowAbsolutePaths,
    fileList,
    localPlatform,
    matchingMenuOptions.length,
    query,
    searchEngine,
    tabResults,
    worktreePath
  ])
  const matchingAgentOptions = useMemo(
    () =>
      terminalQueryMode
        ? EMPTY_AGENT_OPTIONS
        : findMatchingTabAgentLaunchOptions(query, agentOptions),
    [agentOptions, query, terminalQueryMode]
  )
  const matchingQuickCommands = useMemo(
    () =>
      terminalQueryMode
        ? EMPTY_QUICK_COMMAND_OPTIONS
        : findMatchingTabQuickCommandOptions(query, quickCommandOptions),
    [query, quickCommandOptions, terminalQueryMode]
  )

  const activeOptions: ActiveOption[] = [
    ...tabResults.map((option) => ({ kind: 'tab' as const, option })),
    ...matchingMenuOptions.map((option) => ({ kind: 'menu' as const, option })),
    ...matchingAgentOptions.map((option) => ({ kind: 'agent' as const, option })),
    ...matchingQuickCommands.map((option) => ({ kind: 'quick-command' as const, option })),
    ...entryOptions
      .filter(isActiveEntryOption)
      .map((option) => ({ kind: 'entry' as const, option }))
  ]

  return { activeOptions, entryOptions }
}
