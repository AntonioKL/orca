import React from 'react'
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
import { ActivityStatusGroupHeader, ActivityThreadOptionsMenu } from './activity-thread-controls'
import { ActivityThreadRow } from './activity-thread-row'
import type {
  ActivityGroupBy,
  ActivityThreadGroup,
  AgentPaneThread,
  ThreadReadFilter
} from './activity-thread-types'

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
  hasUnreadThreads,
  onCompactModeChange,
  onMarkAllThreadsRead,
  visibleThreadGroups,
  visibleThreadCount,
  selectedPaneKey,
  onSelectThread,
  onJumpToWorkspace,
  onMarkThreadUnread,
  canJumpToWorkspace,
  showJumpAction = true,
  isThreadListResizing,
  onResizeStart
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
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onMarkAllThreadsRead: () => void
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
}): React.JSX.Element {
  // Why: the sidebar hosts this list as a fill-width column, so width and the
  // resize handle are page-only; omitting them lets the flex parent size it.
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
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1">
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
                <SelectItem value="status">
                  {translate('auto.components.activity.ActivityPrototypePage.4a3986b200', 'Status')}
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
                  {translate('auto.components.activity.ActivityPrototypePage.f6396e1f85', 'Agent')}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : null}
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
                <BellDot className="size-3" />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {translate(
                'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                'Show unread threads only'
              )}
            </TooltipContent>
          </Tooltip>
          {/* Why (overflow menu): "Mark all read" is low-frequency and destructive-feeling; behind `…` keeps the toolbar on the frequent Filter + unread toggle. */}
          <ActivityThreadOptionsMenu
            groupBy={groupBy}
            onGroupByChange={onGroupByChange}
            compactMode={compactMode}
            hasUnreadThreads={hasUnreadThreads}
            onCompactModeChange={onCompactModeChange}
            onMarkAllThreadsRead={onMarkAllThreadsRead}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        {visibleThreadGroups.map((group) => (
          <section
            key={group.key}
            aria-label={translate(
              'auto.components.activity.ActivityPrototypePage.a2b4437bfb',
              '{{value0}} activity',
              { value0: group.label }
            )}
          >
            <ActivityStatusGroupHeader group={group} />
            {group.threads.map((thread) => (
              <ActivityThreadRow
                key={thread.paneKey}
                thread={thread}
                selected={thread.paneKey === selectedPaneKey}
                onSelect={() => onSelectThread(thread)}
                onJump={() => onJumpToWorkspace(thread)}
                onMarkUnread={() => onMarkThreadUnread(thread)}
                canJump={canJumpToWorkspace(thread)}
                compactMode={compactMode}
                showJumpAction={showJumpAction}
              />
            ))}
          </section>
        ))}
        {visibleThreadCount === 0 ? (
          <div className="px-3 py-8 text-sm text-muted-foreground">
            {translate(
              'auto.components.activity.ActivityPrototypePage.7cd632006b',
              'No agent activity matches these filters.'
            )}
          </div>
        ) : null}
      </div>
      {resizable ? (
        <div
          aria-label={translate(
            'auto.components.activity.ActivityPrototypePage.443690186e',
            'Resize activity thread list'
          )}
          title={translate(
            'auto.components.activity.ActivityPrototypePage.866083500b',
            'Drag to resize'
          )}
          className={cn(
            'group absolute -right-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize items-stretch justify-center',
            isThreadListResizing && 'bg-ring/10'
          )}
          onMouseDown={onResizeStart}
          role="separator"
        >
          <div
            className={cn(
              'h-full w-px bg-border transition-colors group-hover:bg-ring/50',
              isThreadListResizing && 'bg-ring'
            )}
          />
        </div>
      ) : null}
    </aside>
  )
}
