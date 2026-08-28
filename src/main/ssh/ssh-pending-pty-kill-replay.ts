import type { Store } from '../persistence'
import { isPtyAlreadyGoneError } from '../ipc/pty/provider/liveness'
import type { IPtyProvider } from '../providers/types'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import {
  decideSshPendingPtyKill,
  type SshPendingPtyKillRetirement
} from '../../shared/ssh-pending-pty-kill'

export type SshPendingPtyKillReplayArgs = {
  targetId: string
  store: Store
  provider: IPtyProvider
  shouldContinue: () => boolean
  now?: () => number
}

/** Enough to clear a normal backlog in one round trip without flooding a slow link. */
const REPLAY_CONCURRENCY = 4

type HostInventory = Map<string, string | undefined>

/** Relay pty id -> the incarnation the host published for it, `undefined` when it published none. */
async function readHostInventory(args: SshPendingPtyKillReplayArgs): Promise<HostInventory> {
  const processes = await args.provider.listProcesses()
  const inventory: HostInventory = new Map()
  for (const process of processes) {
    inventory.set(toRelaySshPtyId(args.targetId, process.id), process.incarnationId)
  }
  return inventory
}

function retire(
  args: SshPendingPtyKillReplayArgs,
  relayPtyId: string,
  reason: SshPendingPtyKillRetirement
): void {
  args.store.clearSshRemotePtyKillIntent(args.targetId, relayPtyId)
  if (reason === 'host-reports-absent' || reason === 'stop-confirmed') {
    // The owning host observed absence, which is the only evidence that earns a tombstone. An
    // expired or recycled order retires the intent alone and asserts nothing about any process.
    args.store.markSshRemotePtyLease(args.targetId, relayPtyId, 'terminated')
  }
  console.log(
    `[ssh-pending-kill] retired stop for ${args.targetId}/${relayPtyId} (${reason.replace(/-/g, ' ')})`
  )
}

/** Applies each recorded order against the inventory, and returns the ids that need delivering. */
function selectReplayTargets(
  args: SshPendingPtyKillReplayArgs,
  inventory: HostInventory,
  now: number
): string[] {
  const replayable: string[] = []
  for (const entry of args.store.getSshRemotePtyKillIntents(args.targetId, now)) {
    const decision = decideSshPendingPtyKill(
      entry.intent,
      { hostListsPty: inventory.has(entry.ptyId), hostIncarnationId: inventory.get(entry.ptyId) },
      now
    )
    if (decision.action === 'retire') {
      retire(args, entry.ptyId, decision.reason)
    } else if (decision.action === 'defer') {
      console.warn(
        `[ssh-pending-kill] deferring stop for ${args.targetId}/${entry.ptyId}: ${decision.reason}`
      )
    } else {
      replayable.push(entry.ptyId)
    }
  }
  return replayable
}

/** Issues one recorded stop. Returns false when the order is already settled — the host answered
 *  that the PTY was gone, or the attempt was unverifiable — so the confirming pass skips it. */
async function deliverReplay(
  args: SshPendingPtyKillReplayArgs,
  relayPtyId: string
): Promise<boolean> {
  args.store.noteSshRemotePtyKillReplayAttempt(args.targetId, relayPtyId)
  try {
    await args.provider.shutdown(toAppSshPtyId(args.targetId, relayPtyId), { immediate: true })
    return true
  } catch (err) {
    if (isPtyAlreadyGoneError(err)) {
      retire(args, relayPtyId, 'host-reports-absent')
      return false
    }
    // Loss of contact observes nothing. The order stays for the next handshake.
    console.warn(
      `[ssh-pending-kill] replay for ${args.targetId}/${relayPtyId} is unverifiable: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return false
  }
}

async function deliverAll(
  args: SshPendingPtyKillReplayArgs,
  relayPtyIds: string[]
): Promise<string[]> {
  const awaitingProof: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (args.shouldContinue()) {
      const relayPtyId = relayPtyIds[next++]
      if (relayPtyId === undefined) {
        return
      }
      if (await deliverReplay(args, relayPtyId)) {
        awaitingProof.push(relayPtyId)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REPLAY_CONCURRENCY, relayPtyIds.length) }, worker)
  )
  return awaitingProof
}

/** Confirms the batch against one fresh inventory.
 *
 *  Why re-list at all: the relay answers `pty.shutdown` for a PTY it never had with the same empty
 *  success, so a resolved RPC alone is not a death certificate. Why once for the whole batch: this
 *  runs on the connect path, and a per-PTY verify would put two round trips per order between the
 *  user and a ready connection. */
async function confirmBatch(
  args: SshPendingPtyKillReplayArgs,
  awaitingProof: string[]
): Promise<void> {
  const inventory = await readHostInventory(args)
  for (const relayPtyId of awaitingProof) {
    if (!inventory.has(relayPtyId)) {
      retire(args, relayPtyId, 'stop-confirmed')
    } else {
      console.warn(
        `[ssh-pending-kill] ${args.targetId}/${relayPtyId} is still live after a replayed stop`
      )
    }
  }
}

/** Replays every stop this client could not deliver to `targetId`, now that it is reachable again.
 *
 *  Runs before reattach so a PTY that dies here is never re-adopted as a live pane. Costs nothing
 *  when nothing is pending, and two inventory round trips when something is. */
export async function replayPendingSshPtyKills(args: SshPendingPtyKillReplayArgs): Promise<void> {
  const now = args.now ?? Date.now
  if (args.store.getSshRemotePtyKillIntents(args.targetId, now()).length === 0) {
    return
  }
  let inventory: HostInventory
  try {
    inventory = await readHostInventory(args)
  } catch (err) {
    // No inventory means no fence, and an unfenced replay can kill a shell nobody asked to close.
    console.warn(
      `[ssh-pending-kill] could not list PTYs on ${args.targetId}; stops stay pending: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return
  }
  const replayable = selectReplayTargets(args, inventory, now())
  if (replayable.length === 0 || !args.shouldContinue()) {
    return
  }
  const awaitingProof = await deliverAll(args, replayable)
  if (awaitingProof.length === 0 || !args.shouldContinue()) {
    return
  }
  try {
    await confirmBatch(args, awaitingProof)
  } catch (err) {
    console.warn(
      `[ssh-pending-kill] could not confirm replayed stops on ${args.targetId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
