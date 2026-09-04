import type { OrcaRuntimeService } from '../../orca-runtime'

/**
 * One pass both stamps the automatic-resume fence on every settled worker pane and lifts it from
 * every pane the recovery plan no longer claims. A fenced pane refuses a fresh spawn, so any path
 * that drops a worker's row from that plan — release, user retain, user takeover — has to run the
 * sweep in the same call, or the fence outlives its dispatch and the pane stays unspawnable until
 * the next app start. Failures are swallowed: a fence sweep must never fail the RPC behind it.
 */
export function sweepSettledWorkerResumeFences(runtime: OrcaRuntimeService): void {
  try {
    runtime.prepareLegacyWorkerTerminalRecovery()
  } catch (error) {
    console.warn('[orchestration] settled worker resume fence sweep failed', error)
  }
}
