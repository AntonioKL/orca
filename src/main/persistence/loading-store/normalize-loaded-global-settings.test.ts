import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import {
  normalizeClaudeManagedAccountRuntimes,
  normalizeLoadedGlobalSettings
} from './normalize-loaded-global-settings'

describe('normalizeClaudeManagedAccountRuntimes', () => {
  it('upgrades persisted accounts without a runtime to host isolation', () => {
    const legacy = { id: 'legacy', managedAuthRuntime: undefined }
    const wsl = { id: 'wsl', managedAuthRuntime: 'wsl' as const }

    const normalized = normalizeClaudeManagedAccountRuntimes([legacy, wsl] as never)

    expect(normalized.map((account) => account.managedAuthRuntime)).toEqual(['host', 'wsl'])
  })

  it('applies account runtime backfill through global settings normalization', () => {
    const parsed = getDefaultPersistedState('/tmp/orca-normalize-test')
    parsed.settings = {
      ...parsed.settings,
      claudeManagedAccounts: [{ id: 'legacy', managedAuthRuntime: undefined } as never]
    }
    const terminal = prepareLoadedTerminalSettings(parsed, () => {})
    const profile = prepareLoadedProfileSettings(parsed, terminal.defaults, () => {})

    const normalized = normalizeLoadedGlobalSettings(parsed, terminal, profile)

    expect(normalized.claudeManagedAccounts[0]?.managedAuthRuntime).toBe('host')
  })
})
