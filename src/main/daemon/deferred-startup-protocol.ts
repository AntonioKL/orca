import type { StartupCommandReleaseResult } from '../../shared/deferred-startup-release'

export type ReleaseStartupCommandRequest = {
  id: string
  type: 'releaseStartupCommand'
  payload: {
    sessionId: string
    expectedIncarnationId: string
    operationId: string
  }
}

export type ReleaseStartupCommandResponse = { result: StartupCommandReleaseResult }

export function validateStartupRelease(payload: ReleaseStartupCommandRequest['payload']): void {
  if (
    !payload ||
    [payload.sessionId, payload.expectedIncarnationId, payload.operationId].some(
      (value) => typeof value !== 'string' || value.length === 0
    )
  ) {
    throw new Error('Startup release requires session, incarnation, and operation identities')
  }
}
