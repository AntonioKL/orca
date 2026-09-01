import type { GlobalSettings } from '../../../../shared/global-settings-types'

export function shouldShowAgentDashboardSidebarButton(
  settings:
    | Pick<GlobalSettings, 'showAgentsSidebar' | 'experimentalAgentDashboardPopout'>
    | null
    | undefined
): boolean {
  // Null means settings not yet hydrated; hide so opted-out profiles don't flash Agents UI at startup.
  if (!settings) {
    return false
  }
  return settings.showAgentsSidebar ?? settings.experimentalAgentDashboardPopout ?? true
}
