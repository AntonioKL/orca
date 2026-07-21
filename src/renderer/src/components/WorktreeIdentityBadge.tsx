import React from 'react'
import { GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

type IdentityBadgeDisplay = Extract<WorktreeGitIdentityDisplay, { kind: 'detached' | 'rebasing' }>

type WorktreeIdentityBadgeProps = {
  display: IdentityBadgeDisplay
  label?: 'sidebar' | 'source-control'
  side?: React.ComponentProps<typeof TooltipContent>['side']
  className?: string
  tabIndex?: number
}

export function WorktreeIdentityBadge({
  display,
  label = 'source-control',
  side = 'right',
  className,
  tabIndex
}: WorktreeIdentityBadgeProps): React.JSX.Element {
  const visibleLabel = label === 'sidebar' ? display.sidebarLabel : display.sourceControlLabel
  const Icon = display.kind === 'rebasing' ? RefreshCw : GitCommitHorizontal

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          aria-label={display.tooltip}
          tabIndex={tabIndex}
          className={cn(
            'h-[18px] shrink-0 gap-1 rounded px-1.5 text-[10px] font-medium leading-none',
            'border-[color:color-mix(in_srgb,var(--git-decoration-modified)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--git-decoration-modified)_8%,transparent)] text-[color:var(--git-decoration-modified)]',
            className
          )}
        >
          <Icon className="size-2.5" />
          <span className="min-w-0 truncate">{visibleLabel}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>
        {display.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** Backward-compatible detached-only entry point for existing consumers. */
export function DetachedHeadBadge(
  props: Omit<WorktreeIdentityBadgeProps, 'display'> & {
    display: Extract<WorktreeGitIdentityDisplay, { kind: 'detached' }>
  }
): React.JSX.Element {
  return <WorktreeIdentityBadge {...props} />
}
