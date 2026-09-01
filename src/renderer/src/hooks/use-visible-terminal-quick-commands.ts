import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../shared/terminal-quick-commands'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { terminalQuickCommandMatchesWorkspaceProject } from '@/lib/terminal-quick-command-project-scope'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import {
  flattenTerminalQuickCommandHosts,
  useTerminalQuickCommandHosts,
  type HostedTerminalQuickCommand,
  type TerminalQuickCommandHost
} from '@/hooks/use-terminal-quick-command-hosts'
import type { ExecutionHostId } from '../../../shared/execution-host'

const EMPTY_QUICK_COMMANDS: readonly HostedTerminalQuickCommand[] = []
const EMPTY_REPOS: AppState['repos'] = []
const EMPTY_PROJECT_HOST_SETUPS: ReturnType<
  typeof getProjectHostSetupProjectionFromState
>['setups'] = []

export type VisibleTerminalQuickCommands = {
  executionHostId: ExecutionHostId
  globalCommands: readonly HostedTerminalQuickCommand[]
  hosts: TerminalQuickCommandHost[]
  refreshRemoteHost: () => void
  remoteHostLoadFailed: boolean
  remoteHostPending: boolean
  repoCommands: readonly HostedTerminalQuickCommand[]
  /** null for folder workspaces and floating terminals, which have no repo to scope a run target to. */
  repoId: string | null
  /** Re-exposed so callers that also need the repo list share this subscription. */
  repos: AppState['repos']
}

/**
 * The saved quick commands that apply to one workspace: repo-scoped commands
 * whose project matches the execution host, plus every global command.
 */
export function useVisibleTerminalQuickCommands(
  worktreeId: string,
  enabled = true
): VisibleTerminalQuickCommands {
  // Why every read is `enabled`-gated: a disabled instance must not subscribe to
  // repo or project state, so a caller that only needs commands while a menu is
  // open pays nothing the rest of the time.
  const repos = useAppStore((s) => (enabled ? s.repos : EMPTY_REPOS))
  // Why inlined instead of useProjectHostSetupProjection(): every tab group runs
  // this hook, and a closed menu should not subscribe to project/host state.
  const projectHostSetups = useAppStore((s) =>
    enabled ? getProjectHostSetupProjectionFromState(s).setups : EMPTY_PROJECT_HOST_SETUPS
  )
  const { executionHostId, hosts, refreshRemoteHost, remoteHostLoadFailed, remoteHostPending } =
    useTerminalQuickCommandHosts(worktreeId, enabled)
  // Why: floating terminals share a synthetic worktree id (`global-floating-terminal`)
  // that has no separator, so naive `getRepoIdFromWorktreeId` would return that
  // sentinel as a "repo id" pointing at a repo that doesn't exist.
  const repoId = useMemo(() => {
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      return null
    }
    const candidate = getRepoIdFromWorktreeId(worktreeId)
    return repos.some((r) => r.id === candidate) ? candidate : null
  }, [worktreeId, repos])

  const { repoCommands, globalCommands } = useMemo(() => {
    if (!enabled) {
      return {
        repoCommands: EMPTY_QUICK_COMMANDS,
        globalCommands: EMPTY_QUICK_COMMANDS
      }
    }
    const repoList: HostedTerminalQuickCommand[] = []
    const globalList: HostedTerminalQuickCommand[] = []
    for (const entry of flattenTerminalQuickCommandHosts(hosts)) {
      const { command } = entry
      if (!isTerminalQuickCommandComplete(command)) {
        continue
      }
      const scope = getTerminalQuickCommandScope(command)
      if (scope.type === 'global') {
        globalList.push(entry)
      } else if (
        scope.type === 'repo' &&
        terminalQuickCommandMatchesWorkspaceProject(command, {
          commandHostId: entry.hostId,
          projectHostSetups,
          targetHostId: executionHostId,
          targetRepoId: repoId
        })
      ) {
        repoList.push(entry)
      }
    }
    return { repoCommands: repoList, globalCommands: globalList }
  }, [enabled, executionHostId, hosts, projectHostSetups, repoId])

  return {
    executionHostId,
    globalCommands,
    hosts,
    refreshRemoteHost,
    remoteHostLoadFailed,
    remoteHostPending,
    repoCommands,
    repoId,
    repos
  }
}
