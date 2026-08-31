import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createActivityThreadActions } from '@/components/activity/activity-thread-actions'
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
  onToggleGroupCollapse
}: SidebarAgentsListProps): React.JSX.Element {
  const [compactMode, setCompactMode] = useState(true)
  const [showChildAgents, setShowChildAgents] = useState(false)
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
    allThreads,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    visibleThreadGroups
  } = useAgentPaneThreads({ query, readFilter, groupBy, selectedPaneKey, showChildAgents })

  useEffect(() => {
    if (!selectedPaneKeyIsLive) {
      setSelectedPaneKey(null)
    }
  }, [selectedPaneKeyIsLive])

  const { hasUnreadThreads, markThreadUnread, selectThread, jumpToWorkspace, markAllThreadsRead } =
    createActivityThreadActions({
      allThreads,
      acknowledgeAgents: storeData.acknowledgeAgents,
      unacknowledgeAgents: storeData.unacknowledgeAgents,
      setSelectedPaneKey
    })

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
        visibleThreadGroups={visibleThreadGroups}
        visibleThreadCount={visibleThreads.length}
        selectedPaneKey={effectiveSelectedPaneKey}
        onSelectThread={selectThread}
        onJumpToWorkspace={jumpToWorkspace}
        onMarkThreadUnread={markThreadUnread}
        canJumpToWorkspace={(thread) => storeData.worktreeMap.has(thread.worktree.id)}
        showJumpAction={false}
        showFilterControls={false}
        showOptionsMenu={false}
        collapsedGroupKeys={effectiveCollapsedGroupKeys}
        onToggleGroupCollapse={handleToggleGroup}
      />
      {optionsTarget
        ? createPortal(
            <ActivityThreadOptionsMenu
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              compactMode={compactMode}
              showChildAgents={showChildAgents}
              hasUnreadThreads={hasUnreadThreads}
              onCompactModeChange={setCompactMode}
              onShowChildAgentsChange={setShowChildAgents}
              onMarkAllThreadsRead={markAllThreadsRead}
            />,
            optionsTarget
          )
        : null}
    </>
  )
}
