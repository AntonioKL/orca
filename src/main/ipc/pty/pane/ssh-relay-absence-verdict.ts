import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { IPtyProvider } from '../../../providers/types'

const RELAY_STATUS_TIMEOUT_MS = 5_000
const REPLACEMENT_RELAY_REASON = 'the answering SSH relay is younger than the persisted PTY binding'

type RelayStatus = { uptimeMs?: unknown }

export async function resolveSshRelayAbsenceVerdict(args: {
  provider: IPtyProvider
  bindingCreatedAt?: number
  now?: () => number
}): Promise<PtyLivenessVerdict> {
  if (!args.provider.requestHostRpc || !Number.isFinite(args.bindingCreatedAt)) {
    return { status: 'exited' }
  }
  const bindingAgeAtRequest = (args.now ?? Date.now)() - Number(args.bindingCreatedAt)
  if (bindingAgeAtRequest < 0) {
    return { status: 'exited' }
  }
  try {
    const status = (await args.provider.requestHostRpc(
      'relay.status',
      {},
      {
        timeoutMs: RELAY_STATUS_TIMEOUT_MS
      }
    )) as RelayStatus
    const uptimeMs = status?.uptimeMs
    return typeof uptimeMs === 'number' && Number.isFinite(uptimeMs) && uptimeMs >= 0
      ? uptimeMs < bindingAgeAtRequest
        ? { status: 'unverifiable', reason: REPLACEMENT_RELAY_REASON }
        : { status: 'exited' }
      : { status: 'exited' }
  } catch {
    // The attach response already proved absence; a failed age refinement does not revoke it.
    return { status: 'exited' }
  }
}
