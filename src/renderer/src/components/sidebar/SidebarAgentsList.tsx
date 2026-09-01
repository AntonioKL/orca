import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { ActivityScopeFilterChips } from '@/components/activity/activity-scope-filter-controls'
import {
  clearCompletedActivity,
  isClearableActivityThread
} from '@/components/activity/activity-clear-completed'
import {
  createActivityThreadActions,
  hasActivityThreadWorkspace
} from '@/components/activity/activity-thread-actions'
import { ActivityThreadListPane } from '@/components/activity/activity-thread-list-pane'
import { ActivityThreadOptionsMenu } from '@/components/activity/activity-thread-controls'
import { useAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import type { ActivityGroupBy, ThreadReadFilter } from '@/components/activity/activity-thread-types'

/**
 * The Activity thread list, hosted in the sidebar as a navigator: selecting a
 * row reveals that agent's pane in the workbench instead of swapping the view.
 * Threads whose pane is gone stay listed but inert — activateThreadTerminal
 * already no-ops without a live tab.
 */
export type SidebarAgentsListProps = {
  readFilter: ThreadReadFilter
  setReadFilter: (filter: ThreadReadFilter) => void
  groupBy: ActivityGroupBy
  setGroupBy: (groupBy: ActivityGroupBy) => void
  query: string
  setQuery: (query: string) => void
  optionsTarget?: HTMLElement | null
  collapsedGroupKeys?: ReadonlySet<string>
  onToggleGroupCollapse?: (groupKey: string) => void
  onSearch?: () => void
  unreadOnly?: boolean
  onToggleUnread?: () => void
  scrollTopRef?: React.MutableRefObject<number>
}

export default function SidebarAgentsList({
  readFilter,
  setReadFilter,
  groupBy,
  setGroupBy,
  query,
  setQuery,
  optionsTarget,
  collapsedGroupKeys,
  onToggleGroupCollapse,
  onSearch,
  unreadOnly = false,
  onToggleUnread,
  scrollTopRef
}: SidebarAgentsListProps): React.JSX.Element {
  // Why store-backed: these are persisted preferences (agents* UI fields), unlike the momentary read filter/search.
  const compactMode = useAppStore((s) => s.agentsCompactMode)
  const setCompactMode = useAppStore((s) => s.setAgentsCompactMode)
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const setShowChildAgents = useAppStore((s) => s.setAgentsShowChildAgents)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const [internalCollapsedGroupKeys, setInternalCollapsedGroupKeys] = useState<Set<string>>(
    () => new Set()
  )
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)

  const isControlled = collapsedGroupKeys !== undefined && onToggleGroupCollapse !== undefined
  const effectiveCollapsedGroupKeys = isControlled ? collapsedGroupKeys : internalCollapsedGroupKeys
  const handleToggleGroup = isControlled
    ? onToggleGroupCollapse
    : (groupKey: string) => {
        setInternalCollapsedGroupKeys((prev) => {
          const next = new Set(prev)
          if (next.has(groupKey)) {
            next.delete(groupKey)
          } else {
            next.add(groupKey)
          }
          return next
        })
      }

  const {
    storeData,
    scopedThreads,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    visibleThreadGroups,
    scopeHiddenThreadCount
  } = useAgentPaneThreads({ query, readFilter, groupBy, selectedPaneKey, showChildAgents })

  useEffect(() => {
    if (!selectedPaneKeyIsLive) {
      setSelectedPaneKey(null)
    }
  }, [selectedPaneKeyIsLive])

  // Why useMemo: rows are React.memo'd on these handlers; a fresh closure per render
  // would defeat the bail-out and re-render every mounted row on unrelated updates.
  const {
    hasUnreadThreads,
    markThreadRead,
    markThreadUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead
  } = useMemo(
    () =>
      createActivityThreadActions({
        allThreads: scopedThreads,
        acknowledgeAgents: storeData.acknowledgeAgents,
        unacknowledgeAgents: storeData.unacknowledgeAgents,
        setSelectedPaneKey
      }),
    [scopedThreads, storeData.acknowledgeAgents, storeData.unacknowledgeAgents]
  )

  const hasCompletedThreads = useMemo(
    () => scopedThreads.some(isClearableActivityThread),
    [scopedThreads]
  )
  const handleClearCompleted = useCallback(() => {
    clearCompletedActivity(scopedThreads)
  }, [scopedThreads])

  const canJumpToWorkspace = hasActivityThreadWorkspace

  return (
    <>
      <ActivityThreadListPane
        activityFilterInputRef={activityFilterInputRef}
        query={query}
        onQueryChange={setQuery}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        readFilter={readFilter}
        onReadFilterChange={setReadFilter}
        compactMode={compactMode}
        showChildAgents={showChildAgents}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={setCompactMode}
        onShowChildAgentsChange={setShowChildAgents}
        onMarkAllThreadsRead={markAllThreadsRead}
        onClearCompleted={handleClearCompleted}
        visibleThreadGroups={visibleThreadGroups}
        visibleThreadCount={visibleThreads.length}
        selectedPaneKey={effectiveSelectedPaneKey}
        onSelectThread={selectThread}
        onJumpToWorkspace={jumpToWorkspace}
        onMarkThreadRead={markThreadRead}
        onMarkThreadUnread={markThreadUnread}
        canJumpToWorkspace={canJumpToWorkspace}
        allowMarkUnreadWhenSelected
        showJumpAction={false}
        showFilterControls={false}
        showOptionsMenu={false}
        scopeFilterRow={<ActivityScopeFilterChips hiddenThreadCount={scopeHiddenThreadCount} />}
        collapsedGroupKeys={effectiveCollapsedGroupKeys}
        onToggleGroupCollapse={handleToggleGroup}
        scrollTopRef={scrollTopRef}
      />
      {optionsTarget
        ? createPortal(
            <ActivityThreadOptionsMenu
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              compactMode={compactMode}
              showChildAgents={showChildAgents}
              hasUnreadThreads={hasUnreadThreads}
              hasCompletedThreads={hasCompletedThreads}
              onCompactModeChange={setCompactMode}
              onShowChildAgentsChange={setShowChildAgents}
              onMarkAllThreadsRead={markAllThreadsRead}
              onClearCompleted={handleClearCompleted}
              onSearch={onSearch}
              unreadOnly={unreadOnly}
              onToggleUnread={onToggleUnread}
            />,
            optionsTarget
          )
        : null}
    </>
  )
}
