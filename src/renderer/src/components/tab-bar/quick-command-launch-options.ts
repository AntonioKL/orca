import { normalizeMatchQuery, tokenizeMatchValue } from './query-token-match'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

/** How many quick commands the new-tab menu lists before filtering. */
export const NEW_TAB_MENU_QUICK_COMMAND_LIMIT = 2

/** How many quick-command rows a filtered query may contribute. */
export const QUICK_COMMAND_RESULT_LIMIT = 3

/**
 * The command a "run" affordance defaults to: the group's most recent one
 * regardless of scope, else the first repo command (repo-scoped beats global on
 * first run), else the first global one.
 */
export function resolveRecentQuickCommand(
  repoCommands: readonly HostedTerminalQuickCommand[],
  globalCommands: readonly HostedTerminalQuickCommand[],
  recentId: string | null
): HostedTerminalQuickCommand | null {
  if (recentId) {
    const match =
      repoCommands.find((entry) => entry.key === recentId) ??
      globalCommands.find((entry) => entry.key === recentId) ??
      // Legacy history entries stored the bare command id, not the host-scoped key.
      repoCommands.find((entry) => entry.command.id === recentId) ??
      globalCommands.find((entry) => entry.command.id === recentId)
    if (match) {
      return match
    }
  }
  return repoCommands[0] ?? globalCommands[0] ?? null
}

/**
 * The unfiltered new-tab menu shows only a couple of quick commands so the
 * create/agent lists above it stay readable — most recent first, then repo
 * before global.
 */
export function selectNewTabMenuQuickCommands(
  repoCommands: readonly HostedTerminalQuickCommand[],
  globalCommands: readonly HostedTerminalQuickCommand[],
  recentId: string | null,
  limit = NEW_TAB_MENU_QUICK_COMMAND_LIMIT
): HostedTerminalQuickCommand[] {
  if (limit <= 0) {
    return []
  }
  const recent = resolveRecentQuickCommand(repoCommands, globalCommands, recentId)
  const ordered = [...repoCommands, ...globalCommands]
  const withRecentFirst = recent
    ? [recent, ...ordered.filter((entry) => entry.key !== recent.key)]
    : ordered
  return withRecentFirst.slice(0, limit)
}

// Scores a query against a quick command's label. Exact equality is the
// strongest signal; otherwise every query token must prefix some label token.
//
// Why label-only, and why prefix-only: this list also holds files and URLs, so
// matching the command body (as the quick-commands menu does) would let a
// command containing a path hijack a file query. And these rows rank above the
// file/URL entries with the first one Enter-activated, so a mid-string or
// one-character match could run a shell command the user never aimed at — the
// same hazard `scoreAgentLaunchOption` documents.
function scoreQuickCommandLabel(normalizedQuery: string, label: string): number {
  const normalizedLabel = normalizeMatchQuery(label).toLowerCase()
  if (!normalizedLabel) {
    return 0
  }
  if (normalizedLabel === normalizedQuery) {
    return 1000
  }
  const labelTokens = tokenizeMatchValue(label)
  const queryTokens = tokenizeMatchValue(normalizedQuery)
  if (labelTokens.length === 0 || queryTokens.length === 0) {
    return 0
  }
  let score = normalizedLabel.startsWith(normalizedQuery) ? 10 : 0
  for (const queryToken of queryTokens) {
    let best = 0
    for (const labelToken of labelTokens) {
      if (labelToken === queryToken) {
        best = Math.max(best, 3)
      } else if (queryToken.length >= 2 && labelToken.startsWith(queryToken)) {
        best = Math.max(best, 2)
      }
    }
    if (best === 0) {
      return 0
    }
    score += best
  }
  return score
}

export function findMatchingTabQuickCommandOptions(
  query: string,
  entries: readonly HostedTerminalQuickCommand[],
  limit = QUICK_COMMAND_RESULT_LIMIT
): HostedTerminalQuickCommand[] {
  const normalizedQuery = normalizeMatchQuery(query).toLowerCase()
  if (!normalizedQuery) {
    return []
  }
  return (
    entries
      .map((entry, index) => ({
        entry,
        index,
        score: scoreQuickCommandLabel(normalizedQuery, entry.command.label)
      }))
      .filter((ranked) => ranked.score > 0)
      // Why the index tiebreak: `entries` arrives most-recently-run first, so an
      // ambiguous query prefers the command this group ran last.
      .sort((left, right) =>
        left.score !== right.score ? right.score - left.score : left.index - right.index
      )
      .slice(0, limit)
      .map((ranked) => ranked.entry)
  )
}
