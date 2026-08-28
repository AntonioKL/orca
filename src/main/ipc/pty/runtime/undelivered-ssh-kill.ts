import { ptyIncarnationById } from '../provider/ownership-state'
import { getRelayPtyId } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/** Durably records a stop this client asked for on an SSH host and could not confirm, so the next
 *  handshake to that host can replay it. Without this the remote PTY — a child of the detached
 *  relay daemon, not of the ssh channel — outlives the failed RPC forever.
 *
 *  The silent no-ops are the safety rules, not defensive padding:
 *  - **no `connectionId`**: a local PTY's owner is this process, so a failed kill has no later host
 *    to ask; there is nothing to replay against.
 *  - **no incarnation**: the replay fence is the host-minted PTY incarnation, and a relay renumbers
 *    from `pty-1` on every start. An order we could never safely aim can only be discarded later,
 *    or worse, guessed at.
 *  - **a reversible stop owns this PTY**: worktree sleep leaves the pane live and usable when a
 *    stop does not land, so an order recorded here would come back on a later handshake and kill a
 *    terminal the user had gone back to using. */
export function recordUndeliveredSshPtyKill(
  deps: Pick<PtyRuntimeControllerDeps, 'store' | 'reversibleStopOwnersByPtyId'>,
  ptyId: string,
  connectionId: string | null | undefined,
  /** Pass what `finishPtyShutdown` returned: it clears the live map, so a caller that already ran
   *  it can no longer look the incarnation up. */
  incarnationId?: string,
  now = Date.now()
): void {
  const { store } = deps
  if (!store || !connectionId || deps.reversibleStopOwnersByPtyId.has(ptyId)) {
    return
  }
  const incarnation = incarnationId ?? ptyIncarnationById.get(ptyId)
  if (!incarnation) {
    return
  }
  store.recordSshRemotePtyKillIntent(connectionId, getRelayPtyId(connectionId, ptyId), {
    requestedAt: now,
    incarnationId: incarnation,
    attempts: 0
  })
}
