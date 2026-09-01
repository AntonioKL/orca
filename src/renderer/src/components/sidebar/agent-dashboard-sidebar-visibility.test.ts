import { describe, expect, it } from 'vitest'
import { shouldShowAgentDashboardSidebarButton } from './agent-dashboard-sidebar-visibility'

describe('shouldShowAgentDashboardSidebarButton', () => {
  it('hides while settings are not yet hydrated', () => {
    expect(shouldShowAgentDashboardSidebarButton(null)).toBe(false)
    expect(shouldShowAgentDashboardSidebarButton(undefined)).toBe(false)
  })

  it('honors the explicit setting', () => {
    expect(shouldShowAgentDashboardSidebarButton({ showAgentsSidebar: true })).toBe(true)
    expect(shouldShowAgentDashboardSidebarButton({ showAgentsSidebar: false })).toBe(false)
    expect(
      shouldShowAgentDashboardSidebarButton({
        showAgentsSidebar: false,
        experimentalAgentDashboardPopout: true
      })
    ).toBe(false)
  })

  it('falls back to the legacy popout flag, then defaults on', () => {
    expect(shouldShowAgentDashboardSidebarButton({ experimentalAgentDashboardPopout: true })).toBe(
      true
    )
    expect(shouldShowAgentDashboardSidebarButton({ experimentalAgentDashboardPopout: false })).toBe(
      false
    )
    expect(shouldShowAgentDashboardSidebarButton({})).toBe(true)
  })
})
