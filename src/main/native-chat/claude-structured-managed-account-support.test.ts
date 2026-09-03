import { describe, expect, it } from 'vitest'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'
import {
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from './claude-structured-managed-account-support'

function account(id: string, managedAuthRuntime: 'host' | 'wsl') {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/managed/${id}`,
    managedAuthRuntime,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function settings(
  overrides: Partial<ClaudeManagedAccountGateSettings>
): ClaudeManagedAccountGateSettings {
  return { claudeManagedAccounts: [], activeClaudeManagedAccountId: null, ...overrides }
}

describe('structuredClaudeMatchesActiveManagedAccount', () => {
  it('allows an unmanaged install, where nothing claims an identity', () => {
    expect(structuredClaudeMatchesActiveManagedAccount(settings({}))).toBe(true)
  })

  it('allows a selected host account, which the runtime syncs into the ambient config', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('host-1', 'host')],
          activeClaudeManagedAccountIdsByRuntime: { host: 'host-1', wsl: {} }
        })
      )
    ).toBe(true)
  })

  it('refuses a WSL-only managed account, which never reaches the ambient config', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('wsl-1', 'wsl')],
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
        })
      )
    ).toBe(false)
  })

  it('refuses when a host selection names an account that is WSL-bound or missing', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('wsl-1', 'wsl')],
          activeClaudeManagedAccountIdsByRuntime: { host: 'wsl-1', wsl: {} }
        })
      )
    ).toBe(false)
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({
          claudeManagedAccounts: [account('host-1', 'host')],
          activeClaudeManagedAccountIdsByRuntime: { host: 'gone', wsl: {} }
        })
      )
    ).toBe(false)
  })

  it('fails closed when the settings cannot be read at all', () => {
    expect(structuredClaudeMatchesActiveManagedAccount(null)).toBe(false)
    expect(structuredClaudeMatchesActiveManagedAccount(undefined)).toBe(false)
  })

  it('fails closed when managed accounts exist but no host account is selected', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        settings({ claudeManagedAccounts: [account('host-1', 'host')] })
      )
    ).toBe(false)
  })

  /** The gate and the auth policy must resolve the SAME account. A legacy settings blob carries the
   *  selection only in the flat `activeClaudeManagedAccountId`, which is where the accessor's
   *  fall-through lives — reading the runtime map directly silently disagrees with the policy. */
  it('resolves the same account as the auth policy on a legacy flat selection', () => {
    const legacy = settings({
      claudeManagedAccounts: [account('host-1', 'host')],
      activeClaudeManagedAccountId: 'host-1'
    })

    expect(getSelectedClaudeAccountIdForTarget(legacy, { runtime: 'host' })).toBe('host-1')
    expect(structuredClaudeMatchesActiveManagedAccount(legacy)).toBe(true)
  })

  it('agrees with the auth policy that a legacy flat WSL selection is refused', () => {
    const legacy = settings({
      claudeManagedAccounts: [account('wsl-1', 'wsl')],
      activeClaudeManagedAccountId: 'wsl-1'
    })

    expect(getSelectedClaudeAccountIdForTarget(legacy, { runtime: 'host' })).toBe('wsl-1')
    expect(structuredClaudeMatchesActiveManagedAccount(legacy)).toBe(false)
  })
})
