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
import { SidebarViewToggle } from './sidebar-view-toggle'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  agentToolbar?: React.ReactNode
  agentSearchRow?: React.ReactNode
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange,
  agentToolbar,
  agentSearchRow
}: SidebarHeaderProps) {
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const openModal = useAppStore((s) => s.openModal)
  const newWorktreeShortcutLabel = useShortcutLabel('workspace.create')
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const groupBy = useAppStore((s) => s.groupBy)
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const workspacesLabel = translate(
    'auto.components.sidebar.SidebarHeader.workspaces',
    'Workspaces'
  )
  const projectsLabel = translate('auto.components.sidebar.SidebarHeader.projects', 'Projects')
  const workspaceTabLabel =
    sidebarBody === 'agents' || groupBy === 'none' ? workspacesLabel : projectsLabel

  return (
    <>
      <div className="mt-2 flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2">
        <SidebarViewToggle
          ariaLabel={translate('auto.components.sidebar.SidebarHeader.views', 'Sidebar view')}
          value={sidebarBody === 'agents' ? 'agents' : 'workspaces'}
          onSelect={(value) => setSidebarBody?.(value as 'workspaces' | 'agents')}
          options={[
            {
              value: 'workspaces',
              label: workspaceTabLabel,
              widthLabels: [workspacesLabel, projectsLabel],
              sectionTitle: 'projects'
            },
            {
              value: 'agents',
              label: translate('dashboard.sidebar.label', 'Agents'),
              sectionTitle: 'agents'
            }
          ]}
        />
        {sidebarBody === 'agents' ? <div className="shrink-0">{agentToolbar}</div> : null}
        {sidebarBody === 'workspaces' ? (
          <div className="flex shrink-0 items-center gap-1">
            <SidebarWorkspaceOptionsMenu
              preserveWorkspaceBoardOpen
              onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
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
                  type="button"
                  className="text-muted-foreground"
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
              <TooltipContent side="bottom" sideOffset={6}>
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
      {sidebarBody === 'agents' ? agentSearchRow : null}
    </>
  )
})

export default SidebarHeader
