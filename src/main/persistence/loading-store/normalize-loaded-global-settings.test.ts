import { describe, expect, it } from 'vitest'
import { normalizeClaudeManagedAccountRuntimes } from './normalize-loaded-global-settings'

describe('normalizeClaudeManagedAccountRuntimes', () => {
  it('upgrades persisted accounts without a runtime to host isolation', () => {
    const legacy = { id: 'legacy', managedAuthRuntime: undefined }
    const wsl = { id: 'wsl', managedAuthRuntime: 'wsl' as const }

    const normalized = normalizeClaudeManagedAccountRuntimes([legacy, wsl] as never)

    expect(normalized.map((account) => account.managedAuthRuntime)).toEqual(['host', 'wsl'])
  })
})
