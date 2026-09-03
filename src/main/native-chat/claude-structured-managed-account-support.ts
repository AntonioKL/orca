import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'

/**
 * A structured Claude session launches against the ambient Claude config, which the account service
 * keeps in sync with the selected HOST account. A WSL-bound managed account lives inside the distro
 * and is never synced there, so such a session would authenticate as whatever the ambient identity
 * happens to be while the UI names the WSL account — the user is told one identity and given
 * another. Refuse the structured path there and let the terminal-backed one, which resolves the
 * account per runtime, handle that account shape.
 *
 * Unknown answers refuse: an install with no managed accounts claims no identity and is fine, but
 * an active selection this cannot resolve is not evidence that the ambient identity is right.
 */
export function structuredClaudeMatchesActiveManagedAccount(
  accounts: ClaudeRateLimitAccountsState | null | undefined
): boolean {
  if (!accounts) {
    return false
  }
  if (accounts.accounts.length === 0) {
    return true
  }
  const activeHostId = accounts.activeAccountIdsByRuntime?.host ?? accounts.activeAccountId ?? null
  if (!activeHostId) {
    return false
  }
  const active = accounts.accounts.find((candidate) => candidate.id === activeHostId)
  return active ? active.managedAuthRuntime !== 'wsl' : false
}
