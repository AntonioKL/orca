import type { Session } from './session'
import type { StartupCommandReleaseResult } from './session-deferred-startup'
import { TerminalAttachCanceledError } from './daemon-errors'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'

export function assertTerminalHostCreateAllowed(
  opts: InternalCreateOrAttachOptions,
  creationFenced: boolean
): void {
  if (
    opts.deferredStartupOperationId !== undefined &&
    (!opts.deferredStartupOperationId || !opts.command)
  ) {
    throw new Error('Deferred startup requires an operation identity and command')
  }
  if (creationFenced) {
    throw new Error('Terminal host is shutting down')
  }
  if (opts.isCanceled?.()) {
    throw new TerminalAttachCanceledError(opts.sessionId)
  }
}

export function createTerminalHostStartupReleaser(
  sessions: ReadonlyMap<string, Session>,
  isCreationFenced: () => boolean
) {
  return (
    sessionId: string,
    expectedIncarnationId: string,
    operationId: string
  ): StartupCommandReleaseResult =>
    isCreationFenced()
      ? 'unavailable'
      : (sessions.get(sessionId)?.releaseStartupCommand(expectedIncarnationId, operationId) ??
        'unavailable')
}
