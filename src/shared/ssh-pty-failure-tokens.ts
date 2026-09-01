/**
 * Tokens a failed SSH PTY reattach can carry, shared by the main-process provider that throws them
 * and the renderer consumers that decide what a pane may do next.
 *
 * They are deliberately disjoint strings: every consumer matches with `includes()`, so a token that
 * embedded another would silently inherit its authority.
 */

/**
 * A reachable relay answered for this exact PTY id and the session is gone. The only token that
 * authorises replacing the pane's PTY (see docs/reference/ssh-execution-boundary.md — `exited`
 * requires positive evidence of absence from the host that owns the process).
 */
export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'

/** The relay found the PTY, but it is bound to a different pane identity. */
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

/**
 * The relay proved the PTY is live and only retired its output delivery. Never respawn on this:
 * the shell, its agent, and its work are all still running on the host.
 */
export const SSH_SOURCE_RESTORE_REQUIRED_ERROR = 'SSH_SOURCE_RESTORE_REQUIRED'
