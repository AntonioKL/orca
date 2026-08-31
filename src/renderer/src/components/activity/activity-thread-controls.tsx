import React from 'react'
import { ChevronDown, MoreVertical } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import type { Repo } from '../../../../shared/repo-types'
import {
  formatAbsoluteDate,
  formatCompactRelativeTime,
  formatRelativeTime,
  threadAgentState,
  threadAgentStateLabel
} from './activity-thread-presentation'
import type { ActivityGroupBy, ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'

export function EventTime({
  timestamp,
  compact = false
}: {
  timestamp: number
  compact?: boolean
}): React.JSX.Element {
  const absolute = formatAbsoluteDate(timestamp)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'rounded text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            compact ? 'px-0 py-0 text-[11px] tabular-nums' : 'px-1 py-0.5 text-xs'
          )}
          aria-label={absolute}
          onClick={(event) => event.stopPropagation()}
        >
          {compact ? formatCompactRelativeTime(timestamp) : formatRelativeTime(timestamp)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {absolute}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityThreadOptionsMenu({
  groupBy,
  onGroupByChange,
  compactMode,
  showChildAgents = false,
  hasUnreadThreads,
  onCompactModeChange,
  onShowChildAgentsChange,
  onMarkAllThreadsRead
}: {
  groupBy?: ActivityGroupBy
  onGroupByChange?: (groupBy: ActivityGroupBy) => void
  compactMode: boolean
  showChildAgents?: boolean
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onShowChildAgentsChange?: (showChildAgents: boolean) => void
  onMarkAllThreadsRead: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why: keep Tooltip and Dropdown from composing refs onto the same button (Radix setRef crash loop). */}
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.db8a1878b5',
                  'Thread list options'
                )}
              >
                <MoreVertical className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {translate('auto.components.activity.ActivityPrototypePage.a472a14700', 'More options')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6}>
        {groupBy && onGroupByChange ? (
          <>
            <DropdownMenuLabel>
              {translate(
                'auto.components.activity.ActivityPrototypePage.770d458144',
                'Group agent activity by'
              )}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={groupBy}
              onValueChange={(value) => onGroupByChange(value as ActivityGroupBy)}
            >
              <DropdownMenuRadioItem value="none">
                {translate('auto.components.activity.ActivityPrototypePage.none', 'None')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="status">
                {translate('auto.components.activity.ActivityPrototypePage.4a3986b200', 'Status')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="project">
                {translate('auto.components.activity.ActivityPrototypePage.8c3b621ddf', 'Project')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="worktree">
                {translate('auto.components.activity.ActivityPrototypePage.b29191b3e0', 'Worktree')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="agent">
                {translate('auto.components.activity.ActivityPrototypePage.f6396e1f85', 'Agent')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={compactMode}
          onCheckedChange={(checked) => onCompactModeChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate('auto.components.activity.ActivityPrototypePage.f70e4bec47', 'Compact mode')}
        </DropdownMenuCheckboxItem>
        {onShowChildAgentsChange ? (
          <DropdownMenuCheckboxItem
            checked={showChildAgents}
            onCheckedChange={(checked) => onShowChildAgentsChange(checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {translate(
              'auto.components.activity.ActivityPrototypePage.showChildAgents',
              'Show child agents'
            )}
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onMarkAllThreadsRead} disabled={!hasUnreadThreads}>
          {translate('auto.components.activity.ActivityPrototypePage.023ff75afe', 'Mark all read')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ActivityProjectLabel({ repo }: { repo: Repo | null }): React.JSX.Element {
  const label =
    repo?.displayName?.trim() ||
    translate('auto.components.activity.ActivityPrototypePage.5651b216c6', 'Unknown project')
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {repo ? <RepoBadgeMark color={repo.badgeColor} /> : null}
      <span
        className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
        title={label}
      >
        {label}
      </span>
    </div>
  )
}

export function EventRepoBadge({ repo }: { repo: Repo | null }): React.JSX.Element | null {
  if (!repo) {
    return null
  }
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 dark:border-border/60 dark:bg-accent/50">
      <RepoBadgeMark color={repo.badgeColor} />
      <span className="max-w-[6rem] truncate text-[10px] font-semibold leading-none text-foreground lowercase">
        {repo.displayName}
      </span>
    </div>
  )
}

export function ThreadAgentStateIndicator({
  thread
}: {
  thread: AgentPaneThread
}): React.JSX.Element {
  const state = threadAgentState(thread)
  const label = threadAgentStateLabel(thread)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={state} size="md" title={null} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityStatusGroupHeader({
  group,
  collapsed = false,
  onToggle
}: {
  group: ActivityThreadGroup
  collapsed?: boolean
  onToggle?: () => void
}): React.JSX.Element {
  const isInteractive = Boolean(onToggle)
  return (
    <div
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-expanded={isInteractive ? !collapsed : undefined}
      onClick={onToggle}
      onKeyDown={
        isInteractive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onToggle?.()
              }
            }
          : undefined
      }
      className={cn(
        'sticky top-0 z-10 flex h-7 items-center gap-1.5 bg-background/95 px-1.5 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80 select-none',
        isInteractive && 'cursor-pointer hover:bg-muted/40 transition-colors'
      )}
    >
      <ChevronDown
        className={cn(
          'size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150',
          collapsed && '-rotate-90'
        )}
      />
      {group.state ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={group.state} size="sm" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {group.label}
      </span>
      <span className="rounded-full border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
        {group.threads.length}
      </span>
    </div>
  )
}
