export type AgentsSidebarVisibilitySettings = {
  showAgentsSidebar?: boolean
  experimentalActivity?: boolean
  experimentalAgentDashboardPopout?: boolean
}

export function resolveAgentsSidebarVisible(
  settings: Partial<AgentsSidebarVisibilitySettings> | null | undefined
): boolean {
  if (!settings) {
    return true
  }
  if (typeof settings.showAgentsSidebar === 'boolean') {
    return settings.showAgentsSidebar
  }
  if (settings.experimentalActivity === true) {
    return true
  }
  if (typeof settings.experimentalAgentDashboardPopout === 'boolean') {
    return settings.experimentalAgentDashboardPopout
  }
  return true
}
