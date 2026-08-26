import { randomUUID } from 'node:crypto'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import {
  canonicalWorktreeIdentity,
  composeWorktreeIdentityAlias
} from '../../../shared/worktree/identity'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../shared/workspace-statuses'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type MetadataRuntime = Pick<StoreRuntimeState, 'state'>

function getDefaultWorktreeMeta(): WorktreeMeta {
  return {
    instanceId: randomUUID(),
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}

function migrateLegacyWorktreeMetadata(
  state: StoreRuntimeState['state'],
  worktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  const meta = state.worktreeMeta[worktreeId]
  if (!meta || (meta.hostId !== undefined && meta.hostId !== executionHostId)) {
    return false
  }
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  let changed = false
  const instanceId = meta.instanceId ?? randomUUID()
  if (!meta.instanceId) {
    meta.instanceId = instanceId
    changed = true
  }
  if (!meta.hostId) {
    meta.hostId = executionHostId
    changed = true
  }
  const identityKey = canonicalWorktreeIdentity({
    worktreeId,
    executionHostId,
    instanceId
  })
  if (!state.worktreeMetaByIdentity[identityKey]) {
    state.worktreeMetaByIdentity[identityKey] = {
      ...meta,
      instanceId,
      hostId: executionHostId
    }
    changed = true
  }
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const aliases = state.worktreeIdentityAliases[alias] ?? []
  if (!aliases.includes(identityKey)) {
    state.worktreeIdentityAliases[alias] = [...aliases, identityKey]
    changed = true
  }
  return changed
}

export function removeWorktreeMetadataForHost(
  state: StoreRuntimeState['state'],
  worktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length === 0) {
    return false
  }
  const doomed = new Set(identityKeys)
  for (const identityKey of identityKeys) {
    delete state.worktreeMetaByIdentity?.[identityKey]
  }
  for (const [candidateAlias, candidateKeys] of Object.entries(
    state.worktreeIdentityAliases ?? {}
  )) {
    if (candidateKeys.some((identityKey) => doomed.has(identityKey))) {
      delete state.worktreeIdentityAliases?.[candidateAlias]
    }
  }
  return true
}

export function migrateWorktreeMetadataLocator(
  state: StoreRuntimeState['state'],
  oldWorktreeId: string,
  newWorktreeId: string
): boolean {
  let changed = false
  for (const [oldAlias, identityKeys] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (getWorktreeIdFromHostIdentity(oldAlias) !== oldWorktreeId) {
      continue
    }
    const executionHostId = getExecutionHostIdFromWorktreeHostIdentity(oldAlias)
    if (!executionHostId) {
      continue
    }
    const newAlias = composeWorktreeIdentityAlias(executionHostId, newWorktreeId)
    const existing = state.worktreeIdentityAliases?.[newAlias] ?? []
    state.worktreeIdentityAliases ??= {}
    state.worktreeIdentityAliases[newAlias] = [...new Set([...existing, ...identityKeys])]
    delete state.worktreeIdentityAliases[oldAlias]
    changed = true
  }
  return changed
}
export function getWorktreeMetaForHost(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMeta | undefined {
  const state = runtime.state
  if (migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)) {
    scheduleSave(scheduling)
  }
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length > 1) {
    return undefined
  }
  if (identityKeys.length === 1) {
    return state.worktreeMetaByIdentity?.[identityKeys[0]!]
  }
  const legacy = state.worktreeMeta[worktreeId]
  return !legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined
}

export function setWorktreeMetaForHost(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  meta: Partial<WorktreeMeta>
): WorktreeMeta {
  const state = runtime.state
  if (migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)) {
    scheduleSave(scheduling)
  }
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length > 1) {
    throw new Error('Worktree identity is ambiguous for this host and locator.')
  }
  const existingIdentityKey = identityKeys.length === 1 ? identityKeys[0] : undefined
  const existingIdentityMeta = existingIdentityKey
    ? state.worktreeMetaByIdentity?.[existingIdentityKey]
    : undefined
  const legacy = state.worktreeMeta[worktreeId]
  const existing =
    existingIdentityMeta ??
    (!legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined)
  const instanceId = existing?.instanceId ?? randomUUID()
  const identityKey = canonicalWorktreeIdentity({ worktreeId, executionHostId, instanceId })
  const updated = {
    ...(existing ?? getDefaultWorktreeMeta()),
    ...meta,
    instanceId,
    hostId: executionHostId
  }
  updated.linkedWorkItem = normalizeWorkspaceLinkedItem(updated.linkedWorkItem)
  const linkedTaskSourceContext = normalizeStoredTaskSourceContext(updated.linkedTaskSourceContext)
  updated.linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
    updated.linkedWorkItem,
    linkedTaskSourceContext
  )
    ? linkedTaskSourceContext
    : null
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  state.worktreeMetaByIdentity[identityKey] = updated
  state.worktreeIdentityAliases[alias] = [...new Set([...identityKeys, identityKey])]
  // Keep the legacy projection only for the first known owner.
  if (!legacy || legacy.hostId === executionHostId) {
    state.worktreeMeta[worktreeId] = updated
  }
  scheduleSave(scheduling)
  return updated
}
