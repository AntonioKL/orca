import { SSH_RELAY_REPLACED_ERROR } from './pty-connect-limits'
import type { ColdRestoreAgentResumeStartup, FreshSpawnOptions } from './fresh-spawn-types'

/** Main marks the expiry when `relay.status` proved the answering relay post-dates the binding. */
export function isRelayReplacedSinceBindingError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(SSH_RELAY_REPLACED_ERROR)
}

/**
 * The absence fallback's spawn arguments once the relay that answered is known to have started
 * after we last attached this PTY.
 *
 * The pane still gets a shell — the user asked for a terminal and is owed one. It does not get the
 * agent back: the binding named a PTY from a dead daemon, whose shell may still be running as an
 * orphan, and re-running the resume would put a second agent on that worktree. Declining is
 * recoverable; the duplicate is not (STA-5698).
 *
 * Anything else — an ordinary expiry, a relay too old to report its uptime, a relay that never
 * answered — leaves the fallback untouched.
 */
export function withRelayReplacedResumeSuppressed(
  startup: ColdRestoreAgentResumeStartup | null | undefined,
  relayReplaced: boolean,
  options: FreshSpawnOptions
): [ColdRestoreAgentResumeStartup | null, FreshSpawnOptions] {
  if (!startup || !relayReplaced) {
    return [startup ?? null, options]
  }
  return [null, { ...options, notifyResumeUnavailable: true }]
}
