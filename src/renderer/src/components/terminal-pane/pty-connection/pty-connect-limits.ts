import { e2eConfig } from '@/lib/e2e-config'
import { SSH_PTY_CONNECT_WORST_CASE_MS } from '../../../../../shared/ssh-relay-request-budget'

export const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()
export const pendingSpawnGenerationByPaneKey = new Map<string, number>()
export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
// Why: a connect expires only after every call in its sequence has spent both
// budgets (the bounded wait to reach the wire, then the response window); leave
// one second for the last one's fallback before re-arming locally.
export const DIRECT_SSH_PANE_RETRY_SETTLEMENT_TIMEOUT_MS = SSH_PTY_CONNECT_WORST_CASE_MS + 1_000
export const REMOTE_PTY_ID_PREFIX = 'remote:'
export const PTY_CONNECT_DIAG_LIMIT = 200
export const MANUAL_AGENT_COMMAND_MAX_CHARS = 4096
export const STARTUP_DRAFT_PASTE_QUIET_MS = 1500
// Why a grace window instead of a plain flag: a connect that never settles
// (SSH RPC timeout class, wedged daemon call) would otherwise suppress
// input-triggered recovery FOREVER — and such a pane has no output flowing,
// so no other detector can fire. Past the grace, undeliverable input may
// recover again; the transport's destroyed-check no longer kills a
// pre-existing session when a late reattach resolves, so a remount racing
// a slow-but-alive connect costs a wasted view rebuild, not a shell.
// Sized to the whole connect sequence — both capability probes, spawn, cleanup
// shutdown — not spawn alone, so a connect past it cannot still be live.
export const TRANSPORT_CONNECT_SETTLE_GRACE_MS = SSH_PTY_CONNECT_WORST_CASE_MS

export function recordPtyConnectDiagnostic(message: string): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  console.log(`[pty-connect] ${message}`)
  const target = globalThis as Record<string, unknown>
  const diag = (target.__ptyConnectDiag ??= [] as string[]) as string[]
  diag.push(message)
  if (diag.length > PTY_CONNECT_DIAG_LIMIT) {
    diag.splice(0, diag.length - PTY_CONNECT_DIAG_LIMIT)
  }
}
