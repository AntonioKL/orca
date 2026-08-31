import React, { useEffect, useRef, useState } from 'react'
import { createActivityThreadActions } from '@/components/activity/activity-thread-actions'
import { ActivityThreadListPane } from '@/components/activity/activity-thread-list-pane'
import { useAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import type { ActivityGroupBy, ThreadReadFilter } from '@/components/activity/activity-thread-types'

/**
 * The Activity thread list, hosted in the sidebar as a navigator: selecting a
 * row reveals that agent's pane in the workbench instead of swapping the view.
 * Threads whose pane is gone stay listed but inert — activateThreadTerminal
 * already no-ops without a live tab.
 */
export default function SidebarAgentsList(): React.JSX.Element {
  const [readFilter, setReadFilter] = useState<ThreadReadFilter>('all')
  const [groupBy, setGroupBy] = useState<ActivityGroupBy>('status')
  const [query, setQuery] = useState('')
  const [compactMode, setCompactMode] = useState(true)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)

  const {
    storeData,
    allThreads,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    visibleThreadGroups
  } = useAgentPaneThreads({ query, readFilter, groupBy, selectedPaneKey })

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
    <ActivityThreadListPane
      activityFilterInputRef={activityFilterInputRef}
      query={query}
      onQueryChange={setQuery}
      groupBy={groupBy}
      onGroupByChange={setGroupBy}
      readFilter={readFilter}
      onReadFilterChange={setReadFilter}
      compactMode={compactMode}
      hasUnreadThreads={hasUnreadThreads}
      onCompactModeChange={setCompactMode}
      onMarkAllThreadsRead={markAllThreadsRead}
      visibleThreadGroups={visibleThreadGroups}
      visibleThreadCount={visibleThreads.length}
      selectedPaneKey={effectiveSelectedPaneKey}
      onSelectThread={selectThread}
      onJumpToWorkspace={jumpToWorkspace}
      onMarkThreadUnread={markThreadUnread}
      canJumpToWorkspace={(thread) => storeData.worktreeMap.has(thread.worktree.id)}
      showJumpAction={false}
    />
  )
}
