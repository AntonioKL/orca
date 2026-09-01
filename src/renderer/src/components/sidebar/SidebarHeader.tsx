import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SidebarViewToggle } from './sidebar-view-toggle'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { shouldShowAgentDashboardSidebarButton } from './agent-dashboard-sidebar-visibility'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

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
  // Why the derived boolean, not s.settings: the settings object gets a new identity on
  // every write, which would re-render this memoized header subtree each time.
  const showAgentsSidebarFromStore = useAppStore((s) =>
    shouldShowAgentDashboardSidebarButton(s.settings)
  )
  const showAgentsSidebar = showAgentsSidebarProp ?? showAgentsSidebarFromStore
  const groupBy = useAppStore((s) => s.groupBy)
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const agentsSidebarIntroShown = useAppStore((s) => s.settings?.agentsSidebarIntroShown === true)
  const migratedFromExperimental = useAppStore(
    (s) => s.settings?.agentsSidebarMigratedFromExperimental === true
  )
  const agentsViewActive = showAgentsSidebar && sidebarBody === 'agents'
  const introOpen = showAgentsSidebar && !agentsSidebarIntroShown
  const acknowledgeIntro = React.useCallback(() => {
    void updateSettings?.({ agentsSidebarIntroShown: true })
  }, [updateSettings])
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
        <Popover
          open={introOpen}
          onOpenChange={(open) => {
            if (!open) {
              acknowledgeIntro()
            }
          }}
        >
          <PopoverAnchor asChild>
            <div className="flex h-9 items-center">
              <SidebarViewToggle
                ariaLabel={translate('auto.components.sidebar.SidebarHeader.views', 'Sidebar view')}
                value={agentsViewActive ? 'agents' : 'workspaces'}
                onSelect={(value) => {
                  acknowledgeIntro()
                  setSidebarBody?.(value as 'workspaces' | 'agents')
                }}
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
            </div>
          </PopoverAnchor>
          <PopoverContent side="bottom" align="start" sideOffset={8} className="w-72 p-3">
            <div className="space-y-2">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">
                  {migratedFromExperimental
                    ? translate('agentsSidebarIntro.migrated.title', 'Agents are easier to find')
                    : translate('agentsSidebarIntro.new.title', 'Meet your Agents tab')}
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {migratedFromExperimental
                    ? translate(
                        'agentsSidebarIntro.migrated.description',
                        'Your Agents view is now a dedicated sidebar tab. Your activity and filters are preserved.'
                      )
                    : translate(
                        'agentsSidebarIntro.new.description',
                        'See what your agents are working on, what is done, and where you need to step in.'
                      )}
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" onClick={acknowledgeIntro}>
                  {migratedFromExperimental
                    ? translate('agentsSidebarIntro.migrated.dismiss', 'Got it')
                    : translate('agentsSidebarIntro.new.dismiss', 'Maybe later')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    acknowledgeIntro()
                    setSidebarBody?.('agents')
                  }}
                >
                  {migratedFromExperimental
                    ? translate('agentsSidebarIntro.migrated.action', 'Open Agents')
                    : translate('agentsSidebarIntro.new.action', 'Try Agents')}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
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
