import type { Store } from '../persistence'
import { SSH_RELAY_REPLACED_ERROR } from './ssh-pty-errors'
import type { IPtyProvider } from './types'

/** Bounded so a wedged relay costs the absence fallback nothing: no answer is no verdict. */
const RELAY_STATUS_TIMEOUT_MS = 3_000

/**
 * Did the relay that just answered start AFTER we last attached this PTY?
 *
 * `relay.status` reports the daemon's own `uptimeMs`, and a duration carries no clock skew, so
 * anchoring it to our clock yields a start time comparable to the lease timestamp we wrote
 * ourselves. A daemon that started after our last successful attach cannot be the daemon that
 * held the PTY — the binding names a shell from a previous daemon, which may still be running.
 *
 * Only a relay that actually answers can produce this verdict. A transport failure, a timeout, a
 * relay too old to report `uptimeMs`, or a lease with no attach on record all return false and
 * leave the fallback exactly as it was: loss of contact is never evidence
 * (docs/reference/ssh-execution-boundary.md).
 */
export async function relayStartedAfterLastPtyAttach(args: {
  requestHostRpc: IPtyProvider['requestHostRpc']
  lastAttachedAtMs: number | undefined
  now?: () => number
}): Promise<boolean> {
  if (
    !args.requestHostRpc ||
    typeof args.lastAttachedAtMs !== 'number' ||
    !Number.isFinite(args.lastAttachedAtMs)
  ) {
    return false
  }
  let status: unknown
  try {
    status = await args.requestHostRpc('relay.status', {}, { timeoutMs: RELAY_STATUS_TIMEOUT_MS })
  } catch {
    return false
  }
  const uptimeMs = (status as { uptimeMs?: unknown } | null | undefined)?.uptimeMs
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    return false
  }
  // Round-trip latency inflates the uptime we read, ageing the daemon — which can only ever
  // withdraw the verdict, never invent one.
  return (args.now ?? Date.now)() - uptimeMs > args.lastAttachedAtMs
}

/**
 * Marks a positive-absence reattach failure whose relay post-dates the binding, so the fallback
 * that follows can spawn the shell the user needs without re-running the agent that shell was
 * running. Silent — including on an unreachable relay — for every other reason a PTY is absent.
 */
export async function markSshExpiryFromReplacedRelay(args: {
  error: Error
  provider: Pick<IPtyProvider, 'requestHostRpc'>
  store: Pick<Store, 'getSshRemotePtyLease'> | undefined
  connectionId: string
  relayPtyId: string
}): Promise<void> {
  const lease = args.store?.getSshRemotePtyLease(args.connectionId, args.relayPtyId)
  if (
    !lease ||
    !(await relayStartedAfterLastPtyAttach({
      requestHostRpc: args.provider.requestHostRpc,
      lastAttachedAtMs: lease.lastAttachedAt
    }))
  ) {
    return
  }
  // Why the message: this rides the SSH_SESSION_EXPIRED error the renderer already branches on,
  // the same way SSH_PTY_IDENTITY_MISMATCH does, so no consumer has to learn a new failure shape.
  args.error.message = `${args.error.message} ${SSH_RELAY_REPLACED_ERROR}`
}
