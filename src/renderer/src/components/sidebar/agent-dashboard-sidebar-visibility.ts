import {
  resolveAgentsSidebarVisible,
  type AgentsSidebarVisibilitySettings
} from '../../../../shared/agents-sidebar-visibility'

export function shouldShowAgentDashboardSidebarButton(
  settings: Partial<AgentsSidebarVisibilitySettings> | null | undefined
): boolean {
  // Null means settings not yet hydrated; hide so opted-out profiles don't flash Agents UI at startup.
  if (!settings) {
    return false
  }
  return resolveAgentsSidebarVisible(settings)
}
