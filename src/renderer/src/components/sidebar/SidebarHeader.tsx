import React from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange
}: SidebarHeaderProps) {
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const openModal = useAppStore((s) => s.openModal)
  const newWorktreeShortcutLabel = useShortcutLabel('workspace.create')
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)

  return (
    <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
      <div
        role="radiogroup"
        aria-label={translate('auto.components.sidebar.SidebarHeader.views', 'Sidebar view')}
        className="inline-flex items-center rounded-lg border border-black/10 bg-black/[0.06] p-0.5 shadow-2xs dark:border-white/10 dark:bg-black/40"
      >
        <button
          type="button"
          role="radio"
          aria-checked={sidebarBody === 'workspaces'}
          data-sidebar-section-title="projects"
          onClick={() => setSidebarBody?.('workspaces')}
          className={cn(
            'rounded-md px-2.5 py-0.5 text-xs outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50',
            sidebarBody === 'workspaces'
              ? 'bg-background font-semibold text-foreground shadow-xs border border-black/[0.06] dark:border-white/10 dark:bg-worktree-sidebar-accent dark:text-worktree-sidebar-foreground'
              : 'font-medium text-worktree-sidebar-foreground/65 hover:bg-black/[0.03] hover:text-worktree-sidebar-foreground dark:hover:bg-white/[0.04]'
          )}
        >
          {translate('auto.components.sidebar.SidebarHeader.projects', 'Projects')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sidebarBody === 'agents'}
          data-sidebar-section-title="agents"
          onClick={() => setSidebarBody?.('agents')}
          className={cn(
            'rounded-md px-2.5 py-0.5 text-xs outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50',
            sidebarBody === 'agents'
              ? 'bg-background font-semibold text-foreground shadow-xs border border-black/[0.06] dark:border-white/10 dark:bg-worktree-sidebar-accent dark:text-worktree-sidebar-foreground'
              : 'font-medium text-worktree-sidebar-foreground/65 hover:bg-black/[0.03] hover:text-worktree-sidebar-foreground dark:hover:bg-white/[0.04]'
          )}
        >
          {translate('dashboard.sidebar.label', 'Agents')}
        </button>
      </div>
      {sidebarBody === 'workspaces' ? (
        <div className="flex items-center gap-1 shrink-0">
          <SidebarWorkspaceOptionsMenu
            preserveWorkspaceBoardOpen
            onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={translate(
                  'auto.components.sidebar.SidebarHeader.25a95899c9',
                  'Add Project'
                )}
                onClick={() => openModal('add-repo')}
              >
                <FolderPlus className="size-3.5" strokeWidth={2.25} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.sidebar.SidebarHeader.25a95899c9', 'Add Project')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                // Why: the parallel-work tour must click the real sidebar
                // control so it can hand off to the workspace-creation tour.
                onClick={openWorkspaceCreationComposerWithTourHandoff}
                aria-label={translate(
                  'auto.components.sidebar.SidebarHeader.92154beb7e',
                  'New workspace'
                )}
                data-contextual-tour-target="workspace-create-control"
              >
                <Plus className="size-3.5" strokeWidth={2.25} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>
              {translate(
                'auto.components.sidebar.SidebarHeader.ca6f729da2',
                'New workspace ({{value0}})',
                { value0: newWorktreeShortcutLabel }
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
})

export default SidebarHeader
