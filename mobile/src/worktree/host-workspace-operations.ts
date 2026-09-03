import type { RepoSummary } from './host-worktree-rpc-types'
import type { Worktree } from './workspace-list-types'
import type { WorkspaceViewSettings } from './workspace-view-settings'

export type HostWorkspaceChange = {
  type: 'ready' | 'end' | 'reposChanged' | 'worktreesChanged' | 'error'
}

export type HostWorkspaceOperations = {
  getViewSettings(): Promise<WorkspaceViewSettings | null>
  setViewSettings(settings: WorkspaceViewSettings): Promise<void>
  listRepos(): Promise<RepoSummary[]>
  listWorkspaces(limit: number): Promise<Worktree[]>
  setPinned(workspaceId: string, pinned: boolean): Promise<void>
  removeWorkspace(workspaceId: string): Promise<boolean>
  activateWorkspace(workspaceId: string): Promise<void>
  sleepWorkspace(workspaceId: string): Promise<void>
  notifyForeground(): void
  subscribeChanges(listener: (event: HostWorkspaceChange) => void): () => void
  // Why: a hosted page reads `connected` from the shell's relayed snapshot, so it can issue its
  // first catalog request a beat before that socket serves one. A direct socket omits this.
  readonly connectionStateIsRelayed?: boolean
}
