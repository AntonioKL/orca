import React from 'react'
import { Bell, ExternalLink } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import {
  ActivityProjectLabel,
  EventTime,
  ThreadAgentStateIndicator
} from './activity-thread-controls'
import { activityThreadResponseRenderPreview } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

function isEventFromNestedInteractiveElement(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const interactiveTarget = target.closest(
    'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
  )
  return (
    interactiveTarget instanceof HTMLElement &&
    interactiveTarget !== currentTarget &&
    currentTarget.contains(interactiveTarget)
  )
}

export function ActivityThreadRow({
  thread,
  selected,
  onSelect,
  onJump,
  onMarkUnread,
  canJump,
  compactMode,
  showJumpAction = true
}: {
  thread: AgentPaneThread
  selected: boolean
  onSelect: () => void
  onJump: () => void
  onMarkUnread: () => void
  canJump: boolean
  compactMode: boolean
  showJumpAction?: boolean
}): React.JSX.Element {
  const renderedResponsePreview = activityThreadResponseRenderPreview({
    responsePreview: thread.responsePreview
  })
  const workspaceTitle = getActivityThreadWorkspaceTitle(thread.worktree)
  const taskTitle = thread.paneTitle
  const agentLabel = formatAgentTypeLabel(thread.agentType)
  const hasDistinctTaskTitle = Boolean(taskTitle && taskTitle !== workspaceTitle)
  const showStatusPreview =
    !compactMode &&
    renderedResponsePreview.length > 0 &&
    renderedResponsePreview !== taskTitle &&
    renderedResponsePreview !== workspaceTitle

  return (
    <div
      data-current={selected ? 'true' : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        // Why: markdown responses can contain links; keyboard activation on a nested link follows the link instead of selecting the row.
        if (isEventFromNestedInteractiveElement(event.target, event.currentTarget)) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        // Why (WorktreeCard cues): selected = tint+shadow, beats hover; unread = weight + left bar only; stacking all three confused selected vs unread on hover.
        'group relative flex w-full cursor-pointer flex-col gap-1 border-b border-border px-3 pt-2.5 pb-2.5 text-left transition-colors',
        selected
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : 'hover:bg-accent/40'
      )}
    >
      {thread.unread ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
      ) : null}

      {/* Top row: Status Dot + Agent Icon + Repo Label + Branch / Worktree + Time / Bell */}
      <div className="flex min-w-0 items-center justify-between gap-1.5 text-[10px]">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <ThreadAgentStateIndicator thread={thread} />
          <span className="inline-flex shrink-0">
            <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={13} />
          </span>
          <ActivityProjectLabel repo={thread.repo} />
          {hasDistinctTaskTitle && workspaceTitle !== thread.repo?.displayName ? (
            <span
              className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground font-medium"
              title={workspaceTitle}
            >
              {workspaceTitle}
            </span>
          ) : null}
        </div>
        <div className="inline-flex shrink-0 items-center gap-1">
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
            {thread.unread ? (
              <FilledBellIcon
                className="size-3 shrink-0 text-amber-500 drop-shadow-sm"
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.beb2c19173',
                  'Unread'
                )}
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onMarkUnread()
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    className={cn(
                      'group/unread flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded transition-all',
                      'hover:bg-accent/80 active:scale-95',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    )}
                    aria-label={translate(
                      'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                      'Mark thread unread'
                    )}
                  >
                    <Bell className="size-2.5 text-muted-foreground/40 can-hover:opacity-0 transition-opacity group-hover:opacity-100 group-hover/unread:opacity-100" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                    'Mark thread unread'
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          </span>
          <EventTime timestamp={thread.latestTimestamp} />
        </div>
      </div>

      {/* Main Body: Prompt / Task Title */}
      <div
        className={cn(
          'min-w-0 text-[12px] leading-snug',
          compactMode ? 'truncate' : 'line-clamp-2 break-words',
          thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
        )}
        title={taskTitle || workspaceTitle}
      >
        {taskTitle || workspaceTitle}
      </div>

      {/* Agent Response Snippet Box (Multi-line readable preview) */}
      {showStatusPreview ? (
        <div className="my-0.5 rounded border border-border/50 bg-accent/40 px-2 py-1.5 dark:bg-black/30">
          <CommentMarkdown
            content={renderedResponsePreview}
            className={cn(
              'min-w-0 break-words text-[10.5px] font-mono leading-relaxed text-muted-foreground',
              compactMode ? 'truncate' : 'line-clamp-2',
              '[&_*]:inline [&_*]:!m-0 [&_*]:!p-0 [&_br]:hidden [&_ol]:list-none [&_ul]:list-none'
            )}
            title={thread.responsePreview}
          />
        </div>
      ) : null}

      {/* Footer: Agent Type & Quick Jump Action */}
      <div className="flex min-w-0 items-center justify-between pt-0.5 text-[10px] text-muted-foreground/70">
        <span className="shrink-0">{agentLabel}</span>
        {canJump && showJumpAction ? (
          <span
            className={cn(
              'inline-flex shrink-0 items-center transition-opacity',
              'can-hover:pointer-events-none can-hover:invisible can-hover:opacity-0',
              'group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100'
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-4 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={translate(
                    'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                    'Jump to workspace'
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    onJump()
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <ExternalLink className="size-2.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {translate(
                  'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                  'Jump to workspace'
                )}
              </TooltipContent>
            </Tooltip>
          </span>
        ) : null}
      </div>
    </div>
  )
}
