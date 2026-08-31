/**
 * Budgets an SSH relay RPC spends, and the worst case anything backstopping one
 * has to outlast. A request is written through a bounded writer: while that
 * writer is saturated nothing reaches the wire. Calls that opt into
 * `budgetStartsAtWire` (pty.spawn and the capability probes gating it) wait out
 * that queue on its own bound and only then start the response budget, so a
 * backstop armed for the response budget alone — or for one call in a connect's
 * sequence of them — would fire while the call is still live.
 */
export const SSH_RELAY_REQUEST_TIMEOUT_MS = 30_000
// Why: the dead-link check stands down while the writer is saturated, so this
// bound is the only detector for a frame that never reaches the wire.
export const SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS = 30_000

// Why: never below the caller's own budget, or opting in would shorten a call
// that asked for longer than the flush window.
export function sshRelayQueueWaitMs(timeoutMs: number): number {
  return Math.max(timeoutMs, SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS)
}

// Why: a frame that drains one tick short of the queue bound then goes unanswered
// spends both budgets in full, so the worst case scales with the caller's budget —
// any fixed constant understates every caller that asks for longer than the default.
export function sshRelayRequestWorstCaseMs(timeoutMs: number): number {
  return sshRelayQueueWaitMs(timeoutMs) + timeoutMs
}

// Why: the pane-connect backstops are sized from the spawn worst case, so the
// call site and the backstops read one budget instead of each assuming a default.
export const SSH_PTY_SPAWN_TIMEOUT_MS = SSH_RELAY_REQUEST_TIMEOUT_MS
export const SSH_PTY_SPAWN_WORST_CASE_MS = sshRelayRequestWorstCaseMs(SSH_PTY_SPAWN_TIMEOUT_MS)

// Why: spawn is gated on these probes over the same writer, so they opt into
// the wire-started budget too — otherwise they expire in the queue first and the
// spawn they gate is never enqueued. The window stays short so an unresponsive
// relay still fails fast once the frame is actually out.
export const SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS = 5_000

// Why: SshPtyProvider.spawn() gates on two independently cached probes —
// supportsClaims (agentSessionEnsure) then supportsCreateOperations
// (agentSessionCreateOperationId) — and a launch that asks for both sends both.
const SSH_PTY_CONNECT_CAPABILITY_PROBES = 2

// Why: a pane connect is a sequence of relay calls, not one — the probes gating
// spawn, the spawn, then the shutdown that cleans up a spawn whose claim failed
// validation. A backstop sized from spawn alone fires while the connect is still
// live. The shutdown does not opt in, so it costs its budget from enqueue only.
export const SSH_PTY_CONNECT_WORST_CASE_MS =
  SSH_PTY_CONNECT_CAPABILITY_PROBES *
    sshRelayRequestWorstCaseMs(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS) +
  SSH_PTY_SPAWN_WORST_CASE_MS +
  SSH_RELAY_REQUEST_TIMEOUT_MS
