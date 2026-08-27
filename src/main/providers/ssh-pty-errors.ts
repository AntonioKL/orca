export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

export function isSshPtyNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /PTY ".+" not found/i.test(message)
}

export function isSshPtyIdentityMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}

/** Appended to `SSH_SESSION_EXPIRED` when the relay that reported the PTY absent demonstrably
 *  started after the client last attached it, so the shell it named belonged to a dead daemon. */
export const SSH_RELAY_REPLACED_ERROR = 'SSH_RELAY_REPLACED'

export function isSshRelayReplacedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_RELAY_REPLACED_ERROR)
}
