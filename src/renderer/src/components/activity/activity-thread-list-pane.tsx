import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElementSize,
  observeElementRect,
  useVirtualizer,
  type Range
} from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ActivityThreadListToolbar } from './activity-thread-list-toolbar'
import { ActivityThreadVirtualRow } from './activity-thread-virtual-row'
import { ActivityThreadListResizeHandle } from './activity-thread-list-resize-handle'
import {
  buildActivityVirtualItems,
  estimateActivityVirtualItemSize,
  findActivityThreadItemIndex,
  getActivityVirtualItemKey
} from './activity-thread-virtual-items'
import type {
  ActivityGroupBy,
  ActivityThreadGroup,
  AgentPaneThread,
  ThreadReadFilter
} from './activity-thread-types'

const ZERO_RECT_FALLBACK_VIEWPORT = { width: 320, height: 600 }
const observeActivityListRect: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) => {
    cb(rect.height > 0 ? rect : ZERO_RECT_FALLBACK_VIEWPORT)
  })

export function ActivityThreadListPane({
  threadListRef,
  threadListWidth,
  activityFilterInputRef,
  query,
  onQueryChange,
  groupBy,
  onGroupByChange,
  readFilter,
  onReadFilterChange,
  compactMode,
  showChildAgents,
  hasUnreadThreads,
  onCompactModeChange,
  onShowChildAgentsChange,
  onMarkAllThreadsRead,
  hasCompletedThreads,
  onClearCompleted,
  visibleThreadGroups,
  visibleThreadCount,
  selectedPaneKey,
  onSelectThread,
  onJumpToWorkspace,
  onMarkThreadRead,
  onMarkThreadUnread,
  canJumpToWorkspace,
  allowMarkUnreadWhenSelected = false,
  showJumpAction = true,
  isThreadListResizing,
  onResizeStart,
  showFilterControls = true,
  showOptionsMenu = true,
  scopeFilterRow,
  collapsedGroupKeys,
  onToggleGroupCollapse,
  scrollTopRef
}: {
  threadListRef?: React.RefObject<HTMLDivElement | null>
  threadListWidth?: number
  activityFilterInputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  groupBy: ActivityGroupBy
  onGroupByChange: (groupBy: ActivityGroupBy) => void
  readFilter: ThreadReadFilter
  onReadFilterChange: (readFilter: ThreadReadFilter) => void
  compactMode: boolean
  showChildAgents?: boolean
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onShowChildAgentsChange?: (showChildAgents: boolean) => void
  onMarkAllThreadsRead: () => void
  hasCompletedThreads?: boolean
  onClearCompleted?: () => void
  visibleThreadGroups: ActivityThreadGroup[]
  visibleThreadCount: number
  selectedPaneKey: string | null
  onSelectThread: (thread: AgentPaneThread) => void
  onJumpToWorkspace: (thread: AgentPaneThread) => void
  onMarkThreadRead: (thread: AgentPaneThread) => void
  onMarkThreadUnread: (thread: AgentPaneThread) => void
  canJumpToWorkspace: (thread: AgentPaneThread) => boolean
  allowMarkUnreadWhenSelected?: boolean
  showJumpAction?: boolean
  isThreadListResizing?: boolean
  onResizeStart?: React.MouseEventHandler<HTMLDivElement>
  showFilterControls?: boolean
  showOptionsMenu?: boolean
  /** Rendered between the toolbar and the list; carries the active-scope chips row. */
  scopeFilterRow?: React.ReactNode
  collapsedGroupKeys?: ReadonlySet<string>
  onToggleGroupCollapse?: (groupKey: string) => void
  /** Optional view-local scroll memory; updated without triggering React renders. */
  scrollTopRef?: React.MutableRefObject<number>
}): React.JSX.Element {
  const [internalCollapsedGroupKeys, setInternalCollapsedGroupKeys] = useState<Set<string>>(
    () => new Set()
  )
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

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (scrollTopRef) {
        scrollTopRef.current = event.currentTarget.scrollTop
      }
    },
    [scrollTopRef]
  )
  useEffect(() => {
    if (scrollContainerRef.current && scrollTopRef) {
      scrollContainerRef.current.scrollTop = scrollTopRef.current
    }
  }, [scrollTopRef])
  const virtualItems = useMemo(
    () =>
      buildActivityVirtualItems({
        groups: visibleThreadGroups,
        groupBy,
        collapsedGroupKeys: effectiveCollapsedGroupKeys
      }),
    [visibleThreadGroups, groupBy, effectiveCollapsedGroupKeys]
  )
  const selectedItemIndex = useMemo(
    () => findActivityThreadItemIndex(virtualItems, selectedPaneKey),
    [virtualItems, selectedPaneKey]
  )

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => estimateActivityVirtualItemSize(virtualItems[index], compactMode),
    getItemKey: (index) => {
      const item = virtualItems[index]
      return item ? getActivityVirtualItemKey(item) : `__stale_${index}`
    },
    measureElement: (element, entry, instance) => {
      const measured = measureVirtualElementSize(element, entry, instance)
      if (measured > 0) {
        return measured
      }
      const index = Number.parseInt(element.getAttribute('data-index') ?? '', 10)
      return estimateActivityVirtualItemSize(
        Number.isNaN(index) ? undefined : virtualItems[index],
        compactMode
      )
    },
    rangeExtractor: useCallback(
      (range: Range) => {
        const indexes = defaultRangeExtractor(range)
        if (
          selectedItemIndex !== null &&
          selectedItemIndex >= 0 &&
          !indexes.includes(selectedItemIndex)
        ) {
          indexes.push(selectedItemIndex)
          indexes.sort((a, b) => a - b)
        }
        return indexes
      },
      [selectedItemIndex]
    ),
    overscan: 8,
    observeElementRect: observeActivityListRect,
    useFlushSync: false
  })

  const resizable = onResizeStart !== undefined
  return (
    <aside
      ref={threadListRef}
      className={cn(
        'relative flex min-h-0 flex-col',
        resizable ? 'shrink-0 border-r border-border' : 'min-w-0 flex-1'
      )}
      style={resizable ? { width: threadListWidth } : undefined}
    >
      <ActivityThreadListToolbar
        activityFilterInputRef={activityFilterInputRef}
        query={query}
        onQueryChange={onQueryChange}
        groupBy={groupBy}
        onGroupByChange={onGroupByChange}
        readFilter={readFilter}
        onReadFilterChange={onReadFilterChange}
        compactMode={compactMode}
        showChildAgents={showChildAgents}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={onCompactModeChange}
        onShowChildAgentsChange={onShowChildAgentsChange}
        onMarkAllThreadsRead={onMarkAllThreadsRead}
        hasCompletedThreads={hasCompletedThreads}
        onClearCompleted={onClearCompleted}
        resizable={resizable}
        showFilterControls={showFilterControls}
        showOptionsMenu={showOptionsMenu}
      />
      {scopeFilterRow}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={scrollTopRef ? handleScroll : undefined}
          className="h-full overflow-y-auto overflow-x-hidden p-1.5 scrollbar-sleek"
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
            data-activity-virtual-list=""
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              if (!item) {
                return null
              }
              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <ActivityThreadVirtualRow
                    item={item}
                    collapsed={
                      item.type === 'header' && effectiveCollapsedGroupKeys.has(item.group.key)
                    }
                    onToggleGroup={handleToggleGroup}
                    selectedPaneKey={selectedPaneKey}
                    onSelectThread={onSelectThread}
                    onJumpToWorkspace={onJumpToWorkspace}
                    onMarkThreadRead={onMarkThreadRead}
                    onMarkThreadUnread={onMarkThreadUnread}
                    canJumpToWorkspace={canJumpToWorkspace}
                    compactMode={compactMode}
                    allowMarkUnreadWhenSelected={allowMarkUnreadWhenSelected}
                    showJumpAction={showJumpAction}
                  />
                </div>
              )
            })}
          </div>
          {visibleThreadCount === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.activity.ActivityPrototypePage.7cd632006b',
                'No agent activity matches these filters.'
              )}
            </div>
          ) : null}
        </div>
      </div>
      {resizable ? (
        <ActivityThreadListResizeHandle
          isResizing={isThreadListResizing}
          onResizeStart={onResizeStart}
        />
      ) : null}
    </aside>
  )
}
