import { DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import type { DaemonClient } from './client'
import type { StartupCommandReleaseResult } from '../../shared/deferred-startup-release'
import type {
  ReleaseStartupCommandRequest,
  ReleaseStartupCommandResponse
} from './deferred-startup-protocol'

export async function releaseDaemonStartupCommand(
  client: Pick<DaemonClient, 'request'>,
  protocolVersion: number,
  connect: () => Promise<void>,
  payload: ReleaseStartupCommandRequest['payload']
): Promise<StartupCommandReleaseResult> {
  if (protocolVersion < DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION) {
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
