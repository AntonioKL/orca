import type { ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getCatalogOwnerHostId } from '../lib/worktree-runtime-owner-index'

export type WorkspaceSurface = { id: string; path: string }

type FolderWorkspaceSurfaceRow = Pick<
  FolderWorkspace,
  'id' | 'folderPath' | 'connectionId' | 'executionHostId'
>

/**
 * The terminal workbench's mount set: exactly one surface per workspace id.
 *
 * Why collapse here and nowhere else: the workbench is bare-id keyed end to end
 * (`activeWorktreeId`, `tabsByWorktree`, `mountedWorktreeIdsRef`, React keys),
 * so it can only represent one surface per id — but both catalogs it reads are
 * host-qualified on purpose (STA-4343), keeping a row per (host, id). Emitting
 * both mounts one workspace's tabs twice under a duplicate React key. Listing
 * surfaces such as the sidebar must keep showing every host.
 *
 * `worktreesById` is the store's first-wins per-id index, and that collapse is
 * lossless: `worktreeId` is `repoId::path`, so colliding rows agree on the path.
 */
export function projectWorkspaceSurfaces({
  worktreesById,
  folderWorkspaces,
  activeWorkspaceId,
  activeWorkspaceResolvedHostId
}: {
  worktreesById: ReadonlyMap<string, Pick<Worktree, 'path'>>
  folderWorkspaces: readonly FolderWorkspaceSurfaceRow[]
  activeWorkspaceId: string | null
  /** Resolved (not user-selected) host of the active workspace; the folder tie-break. */
  activeWorkspaceResolvedHostId: ExecutionHostId | null
}): WorkspaceSurface[] {
  const surfaces: WorkspaceSurface[] = []
  for (const [worktreeId, worktree] of worktreesById) {
    surfaces.push({ id: worktreeId, path: worktree.path })
  }
  const folderSurfaceIndexById = new Map<string, number>()
  for (const workspace of folderWorkspaces) {
    const id = folderWorkspaceKey(workspace.id)
    const surface = { id, path: workspace.folderPath }
    const existingIndex = folderSurfaceIndexById.get(id)
    if (existingIndex === undefined) {
      folderSurfaceIndexById.set(id, surfaces.length)
      surfaces.push(surface)
      continue
    }
    // Why: a folder-workspace id is opaque, not path-derived, so colliding hosts
    // disagree on the path; only the active workspace's resolved host breaks the tie.
    // Deriving that host from the row alone is sufficient because every stored row is
    // stamped with an explicit `executionHostId` by `folderWorkspaceWithFetchedOwner`.
    if (
      activeWorkspaceResolvedHostId &&
      id === activeWorkspaceId &&
      getCatalogOwnerHostId(workspace) === activeWorkspaceResolvedHostId
    ) {
      surfaces[existingIndex] = surface
    }
  }
  return surfaces
}
