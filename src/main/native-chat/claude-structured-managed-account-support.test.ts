import { describe, expect, it } from 'vitest'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import { structuredClaudeMatchesActiveManagedAccount } from './claude-structured-managed-account-support'

function account(id: string, managedAuthRuntime: 'host' | 'wsl') {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthRuntime,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function state(overrides: Partial<ClaudeRateLimitAccountsState>): ClaudeRateLimitAccountsState {
  return { accounts: [], activeAccountId: null, ...overrides }
}

describe('structuredClaudeMatchesActiveManagedAccount', () => {
  it('allows an unmanaged install, where nothing claims an identity', () => {
    expect(structuredClaudeMatchesActiveManagedAccount(state({}))).toBe(true)
  })

  it('allows a selected host account, which the runtime syncs into the ambient config', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        state({
          accounts: [account('host-1', 'host')],
          activeAccountIdsByRuntime: { host: 'host-1', wsl: {} }
        })
      )
    ).toBe(true)
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        state({ accounts: [account('host-1', 'host')], activeAccountId: 'host-1' })
      )
    ).toBe(true)
  })

  it('refuses a WSL-only managed account, which never reaches the ambient config', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        state({
          accounts: [account('wsl-1', 'wsl')],
          activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
        })
      )
    ).toBe(false)
  })

  it('refuses when a host selection names an account that is WSL-bound or missing', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        state({
          accounts: [account('wsl-1', 'wsl')],
          activeAccountIdsByRuntime: { host: 'wsl-1', wsl: {} }
        })
      )
    ).toBe(false)
    expect(
      structuredClaudeMatchesActiveManagedAccount(
        state({
          accounts: [account('host-1', 'host')],
          activeAccountIdsByRuntime: { host: 'gone', wsl: {} }
        })
      )
    ).toBe(false)
  })

  it('fails closed when the account state cannot be read at all', () => {
    expect(structuredClaudeMatchesActiveManagedAccount(null)).toBe(false)
    expect(structuredClaudeMatchesActiveManagedAccount(undefined)).toBe(false)
  })

  it('fails closed when managed accounts exist but none is active', () => {
    expect(
      structuredClaudeMatchesActiveManagedAccount(state({ accounts: [account('host-1', 'host')] }))
    ).toBe(false)
  })
})
