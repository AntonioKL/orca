import { toRelaySshPtyId } from './ssh-pty-id'
import { SSH_SOURCE_RESTORE_REQUIRED_ERROR } from './ssh-pty-errors'
import type { PtySpawnResult } from './types'
import {
  reattachSshPtySessionWithExitFence,
  type SshPtyReattachResult
} from './ssh-pty-session-reattach'

/**
 * The full reattach path a spawn takes when it carries a sessionId: fence the exit race, reject a
 * session whose source the relay could not restore, and commit or roll back the source-activation
 * lease.
 *
 * Lives beside `reattachSshPtySession` rather than in SshPtyProvider.spawn so the lease's commit
 * and rollback stay in one place — a caller that only wrapped the fence could return without
 * committing and silently leak the activation.
 */
export async function reattachSshPtySessionForSpawn(
  args: Parameters<typeof reattachSshPtySessionWithExitFence>[0] & {
    acceptLivePty: (relayPtyId: string) => void
  }
): Promise<PtySpawnResult> {
  let result: SshPtyReattachResult | undefined
  try {
    result = await reattachSshPtySessionWithExitFence(args)
    if (result.sourceRecovery?.status === 'restoreRequired') {
      // A restoreRequired answer is a SUCCESSFUL RPC that proved the PTY alive — only its output
      // delivery was retired. Never raise SSH_SESSION_EXPIRED here: that token authorises the
      // renderer to retire the pane binding and cold-start a fresh agent over the same worktree,
      // orphaning live remote work (docs/reference/ssh-execution-boundary.md).
      throw new Error(
        `${SSH_SOURCE_RESTORE_REQUIRED_ERROR}: ${toRelaySshPtyId(args.connectionId, result.id)}`
      )
    }
    args.acceptLivePty(result.id)
    result.sourceActivationLease?.commit()
    const {
      sourceActivationLease: _lease,
      sourceRecovery: _sourceRecovery,
      ...spawnResult
    } = result
    return spawnResult
  } catch (error) {
    result?.sourceActivationLease?.rollback()
    throw error
  }
}
