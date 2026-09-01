import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SidebarViewToggle } from './sidebar-view-toggle'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { shouldShowAgentDashboardSidebarButton } from './agent-dashboard-sidebar-visibility'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  agentToolbar?: React.ReactNode
  agentSearchRow?: React.ReactNode
  showAgentsSidebar?: boolean
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange,
  agentToolbar,
  agentSearchRow,
  showAgentsSidebar: showAgentsSidebarProp
}: SidebarHeaderProps) {
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const settings = useAppStore((s) => s.settings)
  const showAgentsSidebar = showAgentsSidebarProp ?? shouldShowAgentDashboardSidebarButton(settings)
  const groupBy = useAppStore((s) => s.groupBy)
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const agentsViewActive = showAgentsSidebar && sidebarBody === 'agents'
  const spacesLabel = translate('auto.components.sidebar.SidebarHeader.spaces', 'Spaces')
  const projectsLabel = translate('auto.components.sidebar.SidebarHeader.projects', 'Projects')
  // Keep the view name tied to the workspace grouping, not the selected sidebar body.
  const workspaceTabLabel = groupBy === 'none' ? spacesLabel : projectsLabel

  useEffect(() => {
    if (!showAgentsSidebar && sidebarBody === 'agents') {
      setSidebarBody?.('workspaces')
    }
  }, [setSidebarBody, showAgentsSidebar, sidebarBody])

  return (
    <>
      <div className="mt-2 flex h-9 min-w-0 items-center justify-between gap-1.5 px-2">
        <SidebarViewToggle
          ariaLabel={translate('auto.components.sidebar.SidebarHeader.views', 'Sidebar view')}
          value={agentsViewActive ? 'agents' : 'workspaces'}
          onSelect={(value) => setSidebarBody?.(value as 'workspaces' | 'agents')}
          options={[
            {
              value: 'workspaces',
              label: workspaceTabLabel,
              widthLabels: [spacesLabel, projectsLabel],
              sectionTitle: 'projects'
            },
            ...(showAgentsSidebar
              ? [
                  {
                    value: 'agents' as const,
                    label: translate('dashboard.sidebar.label', 'Agents'),
                    sectionTitle: 'agents' as const
                  }
                ]
              : [])
          ]}
        />
        {agentsViewActive ? <div className="shrink-0">{agentToolbar}</div> : null}
        {!agentsViewActive ? (
          <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange} />
        ) : null}
      </div>
      {agentsViewActive ? agentSearchRow : null}
    </>
  )
})

export default SidebarHeader
