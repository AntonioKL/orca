import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'

export type ClaudeManagedAccountGateSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
>

/**
 * A structured Claude session launches against the ambient Claude config, which the account service
 * keeps in sync with the selected HOST account. A WSL-bound managed account lives inside the distro
 * and is never synced there, so such a session would authenticate as whatever the ambient identity
 * happens to be while the UI names the WSL account — the user is told one identity and given
 * another. Refuse the structured path there and let the terminal-backed one, which resolves the
 * account per runtime, handle that account shape.
 *
 * Reads the selection through the same accessor the auth policy uses. Resolving it any other way
 * lets the two disagree, and a session admitted by this gate would then run under a policy computed
 * from a different account than the one approved here.
 *
 * Unknown answers refuse: an install with no managed accounts claims no identity and is fine, but a
 * selection this cannot resolve is not evidence that the ambient identity is right.
 */
export function structuredClaudeMatchesActiveManagedAccount(
  settings: ClaudeManagedAccountGateSettings | null | undefined
): boolean {
  const accounts = settings?.claudeManagedAccounts
  if (!settings || !Array.isArray(accounts)) {
    return false
  }
  if (accounts.length === 0) {
    return true
  }
  const activeHostId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  if (!activeHostId) {
    return false
  }
  const active = accounts.find((candidate) => candidate.id === activeHostId)
  return active ? active.managedAuthRuntime !== 'wsl' : false
}
