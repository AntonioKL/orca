import type { Repo } from '../../../shared/repo-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  attachHostSessionShadow,
  indexWorktreeHostClaims,
  pickPrimaryHostForClaims,
  type WorktreeHostClaims
} from './workspace-session-host-contention'
import {
  nonLocalHostSessionEntries,
  splitWorkspaceSessionByHost,
  type HostSessionSlices,
  type HostIdByWorktreeId
} from './workspace-session-host-split'
import {
  indexWorkspaceRuntimeHostOwnership,
  type WorkspaceRuntimeOwnerProjection
} from './workspace-runtime-host-ownership'

export type HostPersistenceState = {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  projectGroups?: readonly { id: string; executionHostId?: string | null }[]
  folderWorkspaces?: readonly {
    id: string
    projectGroupId: string
    executionHostId?: ExecutionHostId | null
  }[]
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  /** Entries a co-claimant host lost to the primary of a contested workspace id; written straight
   *  back to their own partition so the primary's write cannot erase them. */
  contestedHostWorkspaceSessions?: HostSessionSlices
}

type SessionApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
  patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
  setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
}

type DurableSessionApi = SessionApi & {
  set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
  flush: () => Promise<void>
}

export type WorkspaceSessionHostSnapshot = {
  state: WorkspaceSessionState
  hostId?: ExecutionHostId
}

function getRestoredRuntimeHostId(
  owners: Record<string, ExecutionHostId> | undefined,
  key: string
): ExecutionHostId | null {
  const hostId = owners?.[key]
  return hostId && parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : null
}

function getFolderWorkspaceRuntimeHostId(
  state: HostPersistenceState,
  key: string
): ExecutionHostId {
  const scope = parseWorkspaceKey(key)
  if (scope?.type !== 'folder') {
    return LOCAL_EXECUTION_HOST_ID
  }
  const workspace = state.folderWorkspaces?.find((entry) => entry.id === scope.folderWorkspaceId)
  const group = workspace
    ? state.projectGroups?.find((entry) => entry.id === workspace.projectGroupId)
    : null
  const parsed = parseExecutionHostId(workspace?.executionHostId ?? group?.executionHostId)
  if (parsed) {
    return parsed.kind === 'runtime' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
  if (workspace && group) {
    // Why: once the folder and group catalogs are both known, a missing runtime
    // owner is authoritative local/SSH persistence, not a startup gap.
    return LOCAL_EXECUTION_HOST_ID
  }
  const restoredHostId = getRestoredRuntimeHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    key
  )
  return restoredHostId ?? LOCAL_EXECUTION_HOST_ID
}

export type HostSessionRouting = {
  hostIdByWorktreeId: HostIdByWorktreeId
  claims: WorktreeHostClaims
}

function buildRepoHostById(
  repos: HostPersistenceState['repos']
): Map<string, ExecutionHostId | null> {
  const repoHostById = new Map<string, ExecutionHostId | null>()
  for (const repo of repos) {
    const hostId = getRepoExecutionHostId(repo)
    const existing = repoHostById.get(repo.id)
    // Why: repo ids can repeat across hosts; ambiguous repo-only ownership
    // must not let a runtime placeholder steal local session state.
    repoHostById.set(repo.id, existing === undefined ? hostId : existing === hostId ? hostId : null)
  }
  return repoHostById
}

/** Map a worktree to the host partition it persists under, plus the host claims behind it.
 *
 *  Why: only `runtime:*` worktrees are partitioned out. SSH-owned worktrees stay
 *  in the 'local' partition because the SSH flow already persists them there (in
 *  the unified blob) and separately mirrors them to each target's remote
 *  snapshot — partitioning them too would double-own that data. The one exception is an id two
 *  hosts both publish: it gets a deterministic primary so the co-claimant's rows can be parked in
 *  the shadow instead of sharing one bucket with it. */
export function buildHostSessionRouting(state: HostPersistenceState): HostSessionRouting {
  const repoHostById = buildRepoHostById(state.repos)
  const claims = indexWorktreeHostClaims(state.worktreesByRepo, repoHostById)
  const { repoIdByWorktreeId, runtimeHostIdByWorktreeId } = indexWorkspaceRuntimeHostOwnership(
    state.worktreesByRepo
  )

  const hostIdByWorktreeId = (worktreeId: string): ExecutionHostId => {
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      return getFolderWorkspaceRuntimeHostId(state, worktreeId)
    }
    const rawWorktreeId =
      workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
    const claimed = claims.get(rawWorktreeId)
    if (claimed && claimed.size > 1) {
      // Why: folding a contested id into 'local' gave two workspaces one on-disk bucket. One
      // primary owns the bare key; attachHostSessionShadow keeps the other claimants' rows.
      return pickPrimaryHostForClaims(claimed)
    }
    const worktreeHostId = runtimeHostIdByWorktreeId.get(rawWorktreeId)
    if (runtimeHostIdByWorktreeId.has(rawWorktreeId) && !worktreeHostId) {
      // Why: a bare worktree id whose claimants the catalog cannot name apart stays local.
      return LOCAL_EXECUTION_HOST_ID
    }
    if (worktreeHostId) {
      return worktreeHostId
    }
    const repoId = repoIdByWorktreeId.get(rawWorktreeId) ?? getRepoIdFromWorktreeId(rawWorktreeId)
    const repoHostId = repoId ? repoHostById.get(repoId) : undefined
    if (!repoHostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
    const parsed = parseExecutionHostId(repoHostId)
    return parsed?.kind === 'runtime' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
  return { hostIdByWorktreeId, claims }
}

export function buildHostIdByWorktreeId(state: HostPersistenceState): HostIdByWorktreeId {
  return buildHostSessionRouting(state).hostIdByWorktreeId
}

/** Partition a session for writing: route each entry to its owner host, then restore the parked
 *  rows of every host that lost a contested id so this write cannot erase them. */
function splitWorkspaceSessionForWrite(
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): HostSessionSlices {
  const routing = buildHostSessionRouting(state)
  const slices = splitWorkspaceSessionByHost(payload, routing.hostIdByWorktreeId)
  attachHostSessionShadow(slices, state.contestedHostWorkspaceSessions, routing.claims)
  return slices
}

/** Patch path of the debounced session writer: split the partial patch by owner
 *  host and patch each partition. Returns the promise for the local write so
 *  App.tsx can keep chaining the SSH remote-workspace upload off it. */
export function patchWorkspaceSessionByHost(
  api: SessionApi,
  patch: WorkspaceSessionPatch,
  state: HostPersistenceState
): Promise<void> {
  const slices = splitWorkspaceSessionForWrite(patch as WorkspaceSessionState, state)
  const local = (slices[LOCAL_EXECUTION_HOST_ID] ?? patch) as WorkspaceSessionPatch
  const localWrite = api.patch(local)
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
    // Why: a failed runtime-partition write must not reject the local chain.
    void api.patch(slice as WorkspaceSessionPatch, hostId).catch((err) => {
      console.warn(`[session] host partition patch failed for ${hostId}:`, err)
    })
  }
  return localWrite
}

/** Persist a fresh full snapshot to every owning host partition, then force the
 * main store to disk. Used by request/reply lifecycle operations whose success
 * receipt is a durability boundary rather than a debounced UI update. */
export async function persistWorkspaceSessionByHost(
  api: DurableSessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): Promise<void> {
  const slices = splitWorkspaceSessionForWrite(payload, state)
  const writes: Promise<void>[] = [api.set(slices[LOCAL_EXECUTION_HOST_ID] ?? payload)]
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
    writes.push(api.set(slice, hostId))
  }
  await Promise.all(writes)
  await api.flush()
}

/** Build local-first full-session snapshots for the beforeunload / quit paths. */
export function buildWorkspaceSessionHostSnapshots(
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): WorkspaceSessionHostSnapshot[] {
  const slices = splitWorkspaceSessionForWrite(payload, state)
  return [
    { state: slices[LOCAL_EXECUTION_HOST_ID] ?? payload },
    ...nonLocalHostSessionEntries(slices).map(([hostId, hostState]) => ({
      state: hostState,
      hostId
    }))
  ]
}

/** Synchronous full-session split for the beforeunload / quit paths. */
export function persistWorkspaceSessionByHostSync(
  api: SessionApi,
  payload: WorkspaceSessionState,
  state: HostPersistenceState
): void {
  for (const snapshot of buildWorkspaceSessionHostSnapshots(payload, state)) {
    api.setSync(snapshot.state, snapshot.hostId)
  }
}
