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
  scrollTopRef
}: SidebarAgentsListProps): React.JSX.Element {
  // Why store-backed: these are persisted preferences (agents* UI fields), unlike the momentary read filter/search.
  const compactMode = useAppStore((s) => s.agentsCompactMode)
  const setCompactMode = useAppStore((s) => s.setAgentsCompactMode)
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const setShowChildAgents = useAppStore((s) => s.setAgentsShowChildAgents)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)

  const {
    storeData,
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

  // Why a ref: rows are React.memo'd on these handlers; recreating them whenever the
  // thread array identity changes (every status ping) would re-render every mounted row.
  const visibleThreadsRef = useRef(visibleThreads)
  useEffect(() => {
    visibleThreadsRef.current = visibleThreads
  }, [visibleThreads])
  const { markThreadRead, markThreadUnread, selectThread, jumpToWorkspace, markAllThreadsRead } =
    useMemo(
      () =>
        createActivityThreadActions({
          getVisibleThreads: () => visibleThreadsRef.current,
          acknowledgeAgents: storeData.acknowledgeAgents,
          unacknowledgeAgents: storeData.unacknowledgeAgents,
          setSelectedPaneKey
        }),
      [storeData.acknowledgeAgents, storeData.unacknowledgeAgents]
    )

  // Why visibleThreads: bulk actions and their enablement must match what the list
  // shows — clearing/acking rows hidden by search, unread, or child filters would be silent.
  const hasUnreadThreads = useMemo(() => visibleThreads.some((t) => t.unread), [visibleThreads])
  const hasCompletedThreads = useMemo(
    () => visibleThreads.some(isClearableActivityThread),
    [visibleThreads]
  )
  const handleClearCompleted = useCallback(() => {
    clearCompletedActivity(visibleThreadsRef.current)
  }, [])

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
            />,
            optionsTarget
          )
        : null}
    </>
  )
}
