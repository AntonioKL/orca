import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'

// Simulates a pre-graduation profile: showAgentsSidebar was never persisted.
function normalizeLegacyProfile(overrides: Partial<GlobalSettings>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: Partial<GlobalSettings> = { ...defaults.settings }
  delete settings.showAgentsSidebar
  delete settings.experimentalActivity
  delete settings.experimentalAgentDashboardPopout
  Object.assign(settings, overrides)
  const parsed: PersistedState = { ...defaults, settings: settings as GlobalSettings }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

describe('showAgentsSidebar graduation migration', () => {
  it('keeps the sidebar for Agents-view opt-ins regardless of the popout experiment', () => {
    const normalized = normalizeLegacyProfile({
      experimentalActivity: true,
      experimentalAgentDashboardPopout: false
    })
    expect(normalized.showAgentsSidebar).toBe(true)
    expect(normalized.agentsSidebarMigratedFromExperimental).toBe(true)
  })

  it('graduates either legacy opt-in to the sidebar', () => {
    expect(normalizeLegacyProfile({ experimentalActivity: true }).showAgentsSidebar).toBe(true)
    expect(
      normalizeLegacyProfile({ experimentalAgentDashboardPopout: true }).showAgentsSidebar
    ).toBe(true)
  })

  it('defaults profiles with no legacy signal to the sidebar', () => {
    const normalized = normalizeLegacyProfile({})
    expect(normalized.showAgentsSidebar).toBe(true)
    expect(normalized.agentsSidebarMigratedFromExperimental).toBe(false)
  })

  it('keeps an explicit popout opt-out hidden when the Agents view was never used', () => {
    expect(
      normalizeLegacyProfile({ experimentalAgentDashboardPopout: false }).showAgentsSidebar
    ).toBe(false)
    expect(
      normalizeLegacyProfile({
        experimentalActivity: false,
        experimentalAgentDashboardPopout: false
      }).showAgentsSidebar
    ).toBe(false)
  })

  it('ignores a pre-stamp forced-default experimentalActivity true (not an opt-in)', () => {
    const normalized = normalizeLegacyProfile({
      experimentalActivity: true,
      experimentalActivityDefaultedOffForAllUsers: undefined
    })
    expect(normalized.experimentalActivity).toBe(false)
    expect(normalized.showAgentsSidebar).toBe(true)
    expect(normalized.agentsSidebarMigratedFromExperimental).toBe(false)
  })

  it('preserves a stored showAgentsSidebar choice over legacy flags', () => {
    expect(
      normalizeLegacyProfile({ showAgentsSidebar: false, experimentalActivity: true })
        .showAgentsSidebar
    ).toBe(false)
    expect(
      normalizeLegacyProfile({
        showAgentsSidebar: true,
        experimentalAgentDashboardPopout: false
      }).showAgentsSidebar
    ).toBe(true)
  })
})
