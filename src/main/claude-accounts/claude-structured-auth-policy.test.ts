import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_AUTH_ENV_VARS, shouldStripClaudeAuthEnvForAccount } from './environment'
import { claudeStructuredAuthPolicyForSettings } from './claude-structured-auth-policy'

const HOST_ACCOUNT = { id: 'host-a', managedAuthRuntime: 'host' } as ClaudeManagedAccount
const WSL_ACCOUNT = { id: 'wsl-b', managedAuthRuntime: 'wsl' } as ClaudeManagedAccount
const LEGACY_ACCOUNT = { id: 'legacy-c' } as ClaudeManagedAccount

function settings(
  overrides: Partial<
    Pick<
      GlobalSettings,
      | 'claudeManagedAccounts'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
    >
  >
): Parameters<typeof claudeStructuredAuthPolicyForSettings>[0] {
  return {
    claudeManagedAccounts: [HOST_ACCOUNT, WSL_ACCOUNT, LEGACY_ACCOUNT],
    activeClaudeManagedAccountId: null,
    ...overrides
  } as Parameters<typeof claudeStructuredAuthPolicyForSettings>[0]
}

// The predicate now backs BOTH transports (runtime-auth-preparation.ts and the
// structured wiring), so it needs a test of its own: forcing it to a constant used
// to leave ~1000 tests green.
describe('shouldStripClaudeAuthEnvForAccount', () => {
  it('does not strip when no managed account is selected', () => {
    expect(shouldStripClaudeAuthEnvForAccount([HOST_ACCOUNT], null)).toBe(false)
    expect(shouldStripClaudeAuthEnvForAccount([HOST_ACCOUNT], undefined)).toBe(false)
    expect(shouldStripClaudeAuthEnvForAccount([HOST_ACCOUNT], '')).toBe(false)
  })

  it('strips for a host-managed account', () => {
    expect(shouldStripClaudeAuthEnvForAccount([HOST_ACCOUNT, WSL_ACCOUNT], 'host-a')).toBe(true)
  })

  it('strips for an account with no explicit runtime (the legacy host shape)', () => {
    expect(shouldStripClaudeAuthEnvForAccount([LEGACY_ACCOUNT], 'legacy-c')).toBe(true)
  })

  it('does not strip for a WSL-managed account, matching runtime-auth-preparation', () => {
    expect(shouldStripClaudeAuthEnvForAccount([HOST_ACCOUNT, WSL_ACCOUNT], 'wsl-b')).toBe(false)
  })

  it('strips for a selected id no account list explains', () => {
    // Fail-safe: an id we cannot resolve is treated as a pinned account, never as
    // "no account", so an unreadable settings blob cannot open the strip.
    expect(shouldStripClaudeAuthEnvForAccount([HOST_ACCOUNT], 'deleted-d')).toBe(true)
    expect(shouldStripClaudeAuthEnvForAccount(undefined, 'deleted-d')).toBe(true)
    expect(shouldStripClaudeAuthEnvForAccount([], 'deleted-d')).toBe(true)
  })
})

describe('claudeStructuredAuthPolicyForSettings', () => {
  it('reads the host runtime selection, not the legacy flat field alone', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({
          activeClaudeManagedAccountId: 'host-a',
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
        })
      )
    ).toEqual({ stripAuthEnv: true })
  })

  it('strips when a host account is pinned by runtime selection', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({ activeClaudeManagedAccountIdsByRuntime: { host: 'host-a', wsl: {} } })
      )
    ).toEqual({ stripAuthEnv: true })
  })

  it('does not strip for system auth, so an API-key-only user keeps their sign-in', () => {
    expect(claudeStructuredAuthPolicyForSettings(settings({}))).toEqual({ stripAuthEnv: false })
  })

  it('ignores a WSL-only selection: the structured child is always a native host process', () => {
    expect(
      claudeStructuredAuthPolicyForSettings(
        settings({
          activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-b' } }
        })
      )
    ).toEqual({ stripAuthEnv: false })
  })
})

describe('the strip vocabulary the policy governs', () => {
  it('covers every Anthropic auth variable the terminal path knows about', () => {
    // A new auth var added to the list without a matching refusal/strip path is the
    // shape of the leak this lane already shipped once.
    expect([...CLAUDE_AUTH_ENV_VARS]).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK'
    ])
  })
})
