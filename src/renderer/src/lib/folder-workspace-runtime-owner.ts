import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'
import {
  getSingleFocusedRuntimeEnvironmentId,
  type SingleRuntimeLegacyOwnerState
} from './single-runtime-legacy-owner'

type RuntimeExecutionHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>

export type FolderWorkspaceRuntimeOwnerState = SingleRuntimeLegacyOwnerState & {
  folderWorkspaces?: readonly Pick<
    FolderWorkspace,
    'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
  >[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

function getPreferredFolderExecutionHostId(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  if (executionHostId) {
    return executionHostId
  }
  return state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
    ? (state.activeWorkspaceExecutionHostId ?? undefined)
    : undefined
}

export function findFolderWorkspaceOwner(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
> | null {
  return findIndexedFolderWorkspaceOwner(
    state.folderWorkspaces,
    folderWorkspaceId,
    getPreferredFolderExecutionHostId(state, folderWorkspaceId, executionHostId)
  )
}

function findFolderProjectGroup(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> | null {
  const preferredHostId = getPreferredFolderExecutionHostId(
    state,
    folderWorkspaceId,
    executionHostId
  )
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, preferredHostId)
  if (!folderWorkspace) {
    return null
  }
  return findIndexedProjectGroupOwner(
    state.projectGroups,
    folderWorkspace.projectGroupId,
    preferredHostId
  )
}

function getRestoredRuntimeHostForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): RuntimeExecutionHost | null {
  // Why: runtime folder catalogs load after session hydration; the saved
  // per-host session partition is the only owner evidence during that gap.
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const parsed = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[workspaceKey]
  )
  return parsed?.kind === 'runtime' ? parsed : null
}

export function getRuntimeEnvironmentIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId, executionHostId)
  const parsed = parseExecutionHostId(
    folderWorkspace?.executionHostId ?? projectGroup?.executionHostId
  )
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  if (
    parsed?.kind === 'local' ||
    parsed?.kind === 'ssh' ||
    folderWorkspace?.connectionId?.trim() ||
    projectGroup?.connectionId?.trim()
  ) {
    return null
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.environmentId
  }
  return getSingleFocusedRuntimeEnvironmentId(state)
}

export function getExplicitRuntimeEnvironmentIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId, executionHostId)
  const parsed = parseExecutionHostId(
    folderWorkspace?.executionHostId ?? projectGroup?.executionHostId
  )
  if (parsed) {
    return parsed.kind === 'runtime' ? parsed.environmentId : null
  }
  if (folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()) {
    return null
  }
  return getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)?.environmentId ?? null
}

type FolderWorkspaceExecutionHost = {
  hostId: ExecutionHostId
  /** False when `local` is only the last-resort default and nothing actually named an owner. */
  named: boolean
}

function resolveFolderWorkspaceExecutionHost(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): FolderWorkspaceExecutionHost {
  const preferredHostId = getPreferredFolderExecutionHostId(
    state,
    folderWorkspaceId,
    executionHostId
  )
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, preferredHostId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId, preferredHostId)
  const parsed = parseExecutionHostId(
    folderWorkspace?.executionHostId ?? projectGroup?.executionHostId
  )
  if (parsed) {
    return { hostId: parsed.id, named: true }
  }
  const connectionId = folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()
  if (connectionId) {
    return { hostId: toSshExecutionHostId(connectionId), named: true }
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  const focusedEnvironmentId = getSingleFocusedRuntimeEnvironmentId(state)
  if (preferredHostId && folderWorkspace) {
    // Why: `local` is exactly what folderWorkspaceToWorktree defaults to when a row names nothing,
    // and a sidebar click records that default as the active host — so it is not owner evidence.
    const preferenceNamesOwner = parseExecutionHostId(preferredHostId)?.kind !== 'local'
    return {
      hostId: preferredHostId,
      named: preferenceNamesOwner || Boolean(restoredRuntimeHost) || Boolean(focusedEnvironmentId)
    }
  }
  if (restoredRuntimeHost) {
    return { hostId: restoredRuntimeHost.id, named: true }
  }
  return focusedEnvironmentId
    ? { hostId: `runtime:${encodeURIComponent(focusedEnvironmentId)}`, named: true }
    : { hostId: 'local', named: false }
}

export function getExecutionHostIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostId {
  return resolveFolderWorkspaceExecutionHost(state, folderWorkspaceId, executionHostId).hostId
}

/** Whether any row, session partition or focused runtime actually named this folder's host. */
export function hasNamedFolderWorkspaceExecutionHost(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): boolean {
  return resolveFolderWorkspaceExecutionHost(state, folderWorkspaceId, executionHostId).named
}
