import type { StartupCommandReleaseResult } from '../../../../shared/deferred-startup-release'
import type { IPtyProvider } from '../../../providers/types'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import type { RuntimePtySpawnArgs } from './spawn-state'

export function providerSupportsDeferredStartup(provider: IPtyProvider): boolean {
  return Boolean(provider.releaseStartupCommand && provider.supportsDeferredStartupCommands?.())
}

export async function supportsDeferredStartupFromRuntimeController(
  connectionId?: string | null
): Promise<boolean> {
  return providerSupportsDeferredStartup(getProvider(connectionId))
}

export function assertFreshDeferredStartup(
  args: RuntimePtySpawnArgs,
  existingOwner?: unknown
): void {
  if (args.deferredStartupOperationId === undefined) {
    return
  }
  if (!args.deferredStartupOperationId.trim() || !args.command?.trim()) {
    throw new Error('deferred_startup_requires_command_and_operation')
  }
  if (
    args.commandDelivery === 'renderer' ||
    args.sessionId ||
    args.adoptedStablePane ||
    args.agentSessionEnsure ||
    args.agentSessionCreateOperationId ||
    existingOwner
  ) {
    throw new Error('deferred_startup_requires_fresh_background_terminal')
  }
}

export async function releaseStartupFromRuntimeController(
  ptyId: string,
  expectedIncarnationId: string,
  operationId: string
): Promise<StartupCommandReleaseResult> {
  if (!ptyId.trim() || !expectedIncarnationId.trim() || !operationId.trim()) {
    throw new Error('deferred_startup_invalid_identity')
  }
  // An unknown local id must not fall through to the currently selected provider.
  if (!ptyOwnership.has(ptyId)) {
    return 'unavailable'
  }
  const incarnation = ptyIncarnationById.get(ptyId)
  if (incarnation && incarnation !== expectedIncarnationId) {
    return 'identity-mismatch'
  }
  const provider = getProviderForPty(ptyId)
  if (!provider.releaseStartupCommand) {
    return 'unavailable'
  }
  return provider.releaseStartupCommand(ptyId, expectedIncarnationId, operationId)
}
