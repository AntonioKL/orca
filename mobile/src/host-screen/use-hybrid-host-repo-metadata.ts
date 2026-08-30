import { useCallback } from 'react'
import { repoColor } from '../worktree/repo-color'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'
import type { HybridHostScreenState } from './use-hybrid-host-screen-state'

const REPO_METADATA_REFRESH_MS = 60_000

export function useHybridHostRepoMetadata(args: {
  operations: HostWorkspaceOperations | null
  connState: string
  hostId: string | undefined
  hostState: { cacheRepositories(hostId: string, repositories: readonly unknown[]): void }
  state: HybridHostScreenState
}) {
  const { operations, connState, hostId, hostState, state } = args
  return useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!operations || connState !== 'connected' || !hostId) {
        return
      }
      if (state.fetchRepoMetadataInFlightRef.current.has(operations)) {
        if (options.queueIfInFlight) {
          state.fetchRepoMetadataPendingRef.current.add(operations)
        }
        return
      }
      if (
        !options.force &&
        Date.now() - state.repoMetadataFetchedAtRef.current < REPO_METADATA_REFRESH_MS
      ) {
        return
      }
      state.fetchRepoMetadataInFlightRef.current.add(operations)
      const request = operations,
        requestHostId = hostId
      try {
        do {
          state.fetchRepoMetadataPendingRef.current.delete(request)
          const repos = await request.listRepos()
          if (state.workspaceOperationsRef.current !== request || hostId !== requestHostId) {
            return
          }
          state.repoMetadataFetchedAtRef.current = Date.now()
          hostState.cacheRepositories(requestHostId, repos)
          state.setRepoColorsByName(
            new Map(
              repos.map((repo) => [
                repo.displayName,
                repo.badgeColor || repoColor(repo.displayName)
              ])
            )
          )
          state.setRepoIconsByName(
            new Map(
              repos.flatMap((repo) =>
                repo.repoIcon ? [[repo.displayName, repo.repoIcon] as const] : []
              )
            )
          )
          state.setRepoIdsByName(new Map(repos.map((repo) => [repo.displayName, repo.id])))
        } while (state.fetchRepoMetadataPendingRef.current.has(request))
      } catch {
        // Repo metadata is optional; catalog rows still render without it.
      } finally {
        state.fetchRepoMetadataInFlightRef.current.delete(request)
      }
    },
    [operations, connState, hostId, hostState, state]
  )
}

export type FetchHybridHostRepoMetadata = ReturnType<typeof useHybridHostRepoMetadata>
