import React from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SidebarViewToggle } from './sidebar-view-toggle'
import { SidebarHeaderActions } from './sidebar-header-actions'

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
      <div className="mt-2 flex h-8 min-w-0 items-center justify-between gap-2 px-2">
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
          <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange} />
        ) : null}
      </div>
      {sidebarBody === 'agents' ? agentSearchRow : null}
    </>
  )
})

export default SidebarHeader
