import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SidebarViewToggle } from './sidebar-view-toggle'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { shouldShowAgentDashboardSidebarButton } from './agent-dashboard-sidebar-visibility'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'

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
  // Why: settings are null until hydration; deriving intro visibility from the
  // null default would flash the popover open (and stamp it shown) every launch.
  const settingsHydrated = useAppStore((s) => s.settings != null)
  const agentsViewActive = showAgentsSidebar && sidebarBody === 'agents'
  const agentsUnreadCount = useActivityUnreadCount(showAgentsSidebar, 'sidebar-badge')
  const introOpen = settingsHydrated && showAgentsSidebar && !agentsSidebarIntroShown
  const acknowledgeIntro = React.useCallback(() => {
    void updateSettings?.({ agentsSidebarIntroShown: true })
  }, [updateSettings])
  const deferAgentsIntro = React.useCallback(() => {
    // “Maybe later” means hide the new tab; users can re-enable it in Settings.
    void updateSettings?.({ agentsSidebarIntroShown: true, showAgentsSidebar: false })
    toast(
      translate(
        'agentsSidebarIntro.new.hiddenToast',
        'Agents tab hidden. Re-enable it in Settings → Experimental.'
      )
    )
  }, [updateSettings])
  const spacesLabel = translate('auto.components.sidebar.SidebarHeader.spaces', 'Spaces')
  const projectsLabel = translate('auto.components.sidebar.SidebarHeader.projects', 'Projects')
  // Keep the view name tied to the workspace grouping, not the selected sidebar body.
  const workspaceTabLabel = groupBy === 'none' ? spacesLabel : projectsLabel

  useEffect(() => {
    // Wait for hydration: settings null must not clobber a persisted 'agents' body.
    if (settingsHydrated && !showAgentsSidebar && sidebarBody === 'agents') {
      setSidebarBody?.('workspaces')
    }
  }, [setSidebarBody, settingsHydrated, showAgentsSidebar, sidebarBody])

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
          <div className="flex h-9 items-center">
            <SidebarViewToggle
              ariaLabel={translate('auto.components.sidebar.SidebarHeader.views', 'Sidebar view')}
              value={agentsViewActive ? 'agents' : 'workspaces'}
              onSelect={(value) => {
                // Only stamp the intro as seen when it is actually on screen.
                if (introOpen) {
                  acknowledgeIntro()
                }
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
                        sectionTitle: 'agents' as const,
                        badgeCount: agentsUnreadCount,
                        renderWrapper: (button: React.ReactNode) => (
                          <PopoverAnchor asChild>{button}</PopoverAnchor>
                        )
                      }
                    ]
                  : [])
              ]}
            />
          </div>
          {/* Why: prevent startup terminal/editor auto-focus from dismissing the intro popover. */}
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={10}
            className="w-72 overflow-visible rounded-xl border border-[color-mix(in_srgb,var(--ai-action-accent)_28%,var(--border))] bg-[color-mix(in_srgb,var(--ai-action-accent)_7%,var(--card))] p-3.5 text-card-foreground shadow-[0_12px_28px_-4px_rgba(139,92,246,0.18),0_4px_12px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:border-[color-mix(in_srgb,var(--ai-action-accent)_36%,var(--border))] dark:bg-[color-mix(in_srgb,var(--ai-action-accent)_14%,var(--card))] dark:shadow-[0_16px_36px_-4px_rgba(0,0,0,0.5),0_0_24px_rgba(167,139,250,0.12)]"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onFocusOutside={(event) => event.preventDefault()}
          >
            <PopoverArrow
              width={14}
              height={7}
              className="fill-[color-mix(in_srgb,var(--ai-action-accent)_7%,var(--card))] dark:fill-[color-mix(in_srgb,var(--ai-action-accent)_14%,var(--card))]"
            />
            <div className="space-y-2.5">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="size-3.5 shrink-0 text-[var(--ai-action-accent)]" />
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    {migratedFromExperimental
                      ? translate('agentsSidebarIntro.migrated.title', 'Agents are easier to find')
                      : translate('agentsSidebarIntro.new.title', 'Meet your Agents tab')}
                  </h3>
                </div>
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
                {!migratedFromExperimental ? (
                  <Button variant="ghost" size="sm" onClick={deferAgentsIntro}>
                    {translate('agentsSidebarIntro.new.dismiss', 'Maybe later')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="bg-[var(--ai-action-accent)] text-white hover:bg-[color-mix(in_srgb,var(--ai-action-accent)_85%,black)] dark:hover:bg-[color-mix(in_srgb,var(--ai-action-accent)_85%,white)]"
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
        {agentsViewActive ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Do not add an expand action: the full Agents view is deprecated and must not open. */}
            {agentToolbar}
          </div>
        ) : null}
        {!agentsViewActive ? (
          <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange} />
        ) : null}
      </div>
      {agentsViewActive ? agentSearchRow : null}
    </>
  )
})

export default SidebarHeader
