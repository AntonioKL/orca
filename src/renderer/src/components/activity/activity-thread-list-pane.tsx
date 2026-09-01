import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  defaultRangeExtractor,
  measureElement as measureVirtualElementSize,
  observeElementRect,
  useVirtualizer,
  type Range
} from '@tanstack/react-virtual'
import { BellDot, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getActiveStickyHeaderIndex } from '../sidebar/worktree-list/viewport/virtual-rows'
import { ActivityThreadOptionsMenu } from './activity-thread-controls'
import { ActivityThreadVirtualRow } from './activity-thread-virtual-row'
import { ActivityThreadListResizeHandle } from './activity-thread-list-resize-handle'
import { ActivityThreadStickyHeader } from './activity-thread-sticky-header'
import {
  buildActivityVirtualItems,
  estimateActivityVirtualItemSize,
  findActivityThreadItemIndex,
  getActivityHeaderItemIndexes,
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
  onMarkThreadUnread,
  canJumpToWorkspace,
  showJumpAction = true,
  isThreadListResizing,
  onResizeStart,
  showFilterControls = true,
  showOptionsMenu = true,
  scopeFilterRow,
  collapsedGroupKeys,
  onToggleGroupCollapse
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
  onMarkThreadUnread: (thread: AgentPaneThread) => void
  canJumpToWorkspace: (thread: AgentPaneThread) => boolean
  showJumpAction?: boolean
  isThreadListResizing?: boolean
  onResizeStart?: React.MouseEventHandler<HTMLDivElement>
  showFilterControls?: boolean
  showOptionsMenu?: boolean
  /** Rendered between the toolbar and the list; carries the active-scope chips row. */
  scopeFilterRow?: React.ReactNode
  collapsedGroupKeys?: ReadonlySet<string>
  onToggleGroupCollapse?: (groupKey: string) => void
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
  const virtualItems = useMemo(
    () =>
      buildActivityVirtualItems({
        groups: visibleThreadGroups,
        groupBy,
        collapsedGroupKeys: effectiveCollapsedGroupKeys
      }),
    [visibleThreadGroups, groupBy, effectiveCollapsedGroupKeys]
  )
  const headerItemIndexes = useMemo(
    () => getActivityHeaderItemIndexes(virtualItems),
    [virtualItems]
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

  const rangeStartIndex = virtualizer.range?.startIndex ?? 0
  const stickyHeaderIndex =
    groupBy !== 'none' ? getActiveStickyHeaderIndex(headerItemIndexes, rangeStartIndex) : null
  const stickyHeaderItem = stickyHeaderIndex === null ? null : virtualItems[stickyHeaderIndex]

  const resizable = onResizeStart !== undefined
  const showToolbar = showFilterControls || showOptionsMenu
  return (
    <aside
      ref={threadListRef}
      className={cn(
        'relative flex min-h-0 flex-col',
        resizable ? 'shrink-0 border-r border-border' : 'min-w-0 flex-1'
      )}
      style={resizable ? { width: threadListWidth } : undefined}
    >
      {showToolbar ? (
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <div className="flex items-center gap-1">
            {showFilterControls ? (
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={activityFilterInputRef}
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder={translate(
                    'auto.components.activity.ActivityPrototypePage.795cbf26e2',
                    'Filter...'
                  )}
                  className={cn('h-7 w-full pl-6 text-[11px]', query ? 'pr-6' : '')}
                />
                {query ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 size-5 p-0 text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.sidebar.WorkspaceKanbanSearchField.3b7ea51793',
                      'Clear search'
                    )}
                    onClick={() => {
                      onQueryChange('')
                      activityFilterInputRef.current?.focus()
                    }}
                  >
                    <X className="size-2.5" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            {resizable ? (
              <Select
                value={groupBy}
                onValueChange={(value) => onGroupByChange(value as ActivityGroupBy)}
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 w-[116px] shrink-0 px-2 text-[11px]"
                  aria-label={translate(
                    'auto.components.activity.ActivityPrototypePage.770d458144',
                    'Group agent activity by'
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="none">
                    {translate('auto.components.activity.ActivityPrototypePage.none', 'None')}
                  </SelectItem>
                  <SelectItem value="status">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.4a3986b200',
                      'Status'
                    )}
                  </SelectItem>
                  <SelectItem value="project">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.8c3b621ddf',
                      'Project'
                    )}
                  </SelectItem>
                  <SelectItem value="worktree">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.b29191b3e0',
                      'Worktree'
                    )}
                  </SelectItem>
                  <SelectItem value="agent">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.f6396e1f85',
                      'Agent'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {showFilterControls ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    pressed={readFilter === 'unread'}
                    onPressedChange={(pressed) => onReadFilterChange(pressed ? 'unread' : 'all')}
                    size="sm"
                    className={cn(
                      'size-7 shrink-0 p-0 rounded-md transition-all',
                      readFilter === 'unread'
                        ? '!border border-primary/50 !bg-primary/20 !text-primary shadow-2xs hover:!bg-primary/30'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    )}
                    aria-label={translate(
                      'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                      'Show unread threads only'
                    )}
                  >
                    <BellDot className="size-3.5" strokeWidth={2.25} />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                    'Show unread threads only'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {showOptionsMenu ? (
              <ActivityThreadOptionsMenu
                groupBy={groupBy}
                onGroupByChange={onGroupByChange}
                compactMode={compactMode}
                showChildAgents={showChildAgents}
                hasUnreadThreads={hasUnreadThreads}
                hasCompletedThreads={hasCompletedThreads}
                onCompactModeChange={onCompactModeChange}
                onShowChildAgentsChange={onShowChildAgentsChange}
                onMarkAllThreadsRead={onMarkAllThreadsRead}
                onClearCompleted={onClearCompleted}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {scopeFilterRow}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
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
                    onMarkThreadUnread={onMarkThreadUnread}
                    canJumpToWorkspace={canJumpToWorkspace}
                    compactMode={compactMode}
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
        {stickyHeaderItem?.type === 'header' ? (
          <ActivityThreadStickyHeader
            group={stickyHeaderItem.group}
            collapsed={effectiveCollapsedGroupKeys.has(stickyHeaderItem.group.key)}
            onToggle={() => handleToggleGroup(stickyHeaderItem.group.key)}
          />
        ) : null}
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
