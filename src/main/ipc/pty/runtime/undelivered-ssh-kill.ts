import type { Store } from '../../../persistence'
import { ptyIncarnationById } from '../provider/ownership-state'
import { getRelayPtyId } from '../provider/registry'

/** Durably records a stop this client asked for on an SSH host and could not confirm, so the next
 *  handshake to that host can replay it. Without this the remote PTY — a child of the detached
 *  relay daemon, not of the ssh channel — outlives the failed RPC forever.
 *
 *  Silent no-ops are deliberate, not defensive padding:
 *  - no `connectionId`: a local PTY's owner is this process, so a failed kill has no later host to
 *    ask; there is nothing to replay against.
 *  - no incarnation: the replay fence is the host-minted PTY incarnation, and a relay renumbers
 *    from `pty-1` on every start. Recording an intent we could never safely aim would leave a kill
 *    order that can only be discarded, or worse, guessed at. */
export function recordUndeliveredSshPtyKill(args: {
  store: Store | undefined
  ptyId: string
  connectionId: string | null | undefined
  /** Pass the value `finishPtyShutdown` returned: it clears the live map, so a caller that already
   *  ran it can no longer look the incarnation up. */
  incarnationId?: string
  now?: number
}): void {
  const { store, ptyId, connectionId } = args
  if (!store || !connectionId) {
    return
  }
  const incarnationId = args.incarnationId ?? ptyIncarnationById.get(ptyId)
  if (!incarnationId) {
    return
  }
  const now = args.now ?? Date.now()
  store.recordSshRemotePtyKillIntent(connectionId, getRelayPtyId(connectionId, ptyId), {
    requestedAt: now,
    incarnationId,
    attempts: 0
  })
}
