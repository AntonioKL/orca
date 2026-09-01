import type { GlobalSettings } from '../../../../shared/global-settings-types'

export function shouldShowAgentDashboardSidebarButton(
  settings:
    | Pick<GlobalSettings, 'showAgentsSidebar' | 'experimentalAgentDashboardPopout'>
    | null
    | undefined
): boolean {
  return settings?.showAgentsSidebar ?? settings?.experimentalAgentDashboardPopout ?? true
}
