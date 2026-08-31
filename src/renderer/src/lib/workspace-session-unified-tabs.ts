import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { dedupeEditorTabsWithinGroups } from '../store/slices/tab-group-state'

type PersistedUnifiedTabSessionData = Pick<
  WorkspaceSessionState,
  'activeGroupIdByWorktree' | 'tabGroupLayouts' | 'tabGroups' | 'unifiedTabs'
>

function dedupePersistedTabIds(tabIds: string[]): string[] {
  return Array.from(new Set(tabIds))
}

function prunePersistedLayoutForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return validGroupIds.has(root.groupId) ? root : null
  }

  const first = prunePersistedLayoutForGroups(root.first, validGroupIds)
  const second = prunePersistedLayoutForGroups(root.second, validGroupIds)

  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }

  return { ...root, first, second }
}

function buildPersistedGroupsForWorktree(
  tabs: Tab[],
  groups: TabGroup[],
  tabIdAliasesByGroup?: Map<string, Map<string, string>>
): TabGroup[] {
  const validTabIds = new Set(tabs.map((tab) => tab.id))
  const tabIdsByGroup = new Map<string, string[]>()
  for (const tab of tabs) {
    const groupTabs = tabIdsByGroup.get(tab.groupId) ?? []
    groupTabs.push(tab.id)
    tabIdsByGroup.set(tab.groupId, groupTabs)
  }

  return groups
    .map((group) => {
      const aliases = tabIdAliasesByGroup?.get(group.id)
      const canonicalTabId = (tabId: string): string => aliases?.get(tabId) ?? tabId
      const tabOrder = dedupePersistedTabIds([
        ...group.tabOrder.map(canonicalTabId).filter((tabId) => validTabIds.has(tabId)),
        ...(tabIdsByGroup.get(group.id) ?? [])
      ])
      const activeTabId =
        group.activeTabId && tabOrder.includes(canonicalTabId(group.activeTabId))
          ? canonicalTabId(group.activeTabId)
          : null
      const recentTabIds = group.recentTabIds
        ? dedupePersistedTabIds(
            group.recentTabIds.map(canonicalTabId).filter((tabId) => tabOrder.includes(tabId))
          )
        : group.recentTabIds
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds
      }
    })
    .filter((group) => group.tabOrder.length > 0)
}

export function buildPersistedUnifiedTabSessionData(
  snapshot: Pick<
    WorkspaceSessionSnapshot,
    'activeGroupIdByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'unifiedTabsByWorktree'
  >
): PersistedUnifiedTabSessionData {
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const sourceTabs = snapshot.unifiedTabsByWorktree ?? {}
  const sourceGroups = snapshot.groupsByWorktree ?? {}
  const sourceLayouts = snapshot.layoutByWorktree ?? {}
  const sourceActiveGroups = snapshot.activeGroupIdByWorktree ?? {}
  const worktreeIds = new Set([
    ...Object.keys(sourceTabs),
    ...Object.keys(sourceGroups),
    ...Object.keys(sourceLayouts)
  ])

  for (const worktreeId of worktreeIds) {
    const tabs = sourceTabs[worktreeId] ?? []
    if (tabs.length === 0) {
      continue
    }

    const deduped = dedupeEditorTabsWithinGroups(tabs)
    const groups = buildPersistedGroupsForWorktree(
      deduped.tabs,
      sourceGroups[worktreeId] ?? [],
      deduped.tabIdAliasesByGroup
    )
    if (groups.length === 0) {
      continue
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const persistedTabs = deduped.tabs.filter((tab) => groupIds.has(tab.groupId))
    if (persistedTabs.length === 0) {
      continue
    }

    unifiedTabs[worktreeId] = persistedTabs
    tabGroups[worktreeId] = groups
    const activeGroupId = sourceActiveGroups[worktreeId]
    activeGroupIdByWorktree[worktreeId] =
      activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : groups[0].id
    const prunedLayout = sourceLayouts[worktreeId]
      ? prunePersistedLayoutForGroups(sourceLayouts[worktreeId], groupIds)
      : null
    tabGroupLayouts[worktreeId] = prunedLayout ?? { type: 'leaf', groupId: groups[0].id }
  }

  return {
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree
  }
}
