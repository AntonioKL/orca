import type { DaemonClient } from './client'
import type { StartupCommandReleaseResult } from '../../shared/deferred-startup-release'
import type {
  ReleaseStartupCommandRequest,
  ReleaseStartupCommandResponse
} from './deferred-startup-protocol'

export async function releaseDaemonStartupCommand(
  client: Pick<DaemonClient, 'request'>,
  supported: boolean,
  connect: () => Promise<void>,
  payload: ReleaseStartupCommandRequest['payload']
): Promise<StartupCommandReleaseResult> {
  if (!supported) {
    return 'unavailable'
  }
  // Reconnect to the owner; never use create/respawn recovery for command release.
  await connect()
  const response = await client.request<ReleaseStartupCommandResponse>(
    'releaseStartupCommand',
    payload
  )
  return response.result
}
