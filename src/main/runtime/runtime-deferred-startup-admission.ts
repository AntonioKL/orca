import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

export function assertTerminalCreate(
  selector: string | undefined,
  options: TerminalCreateOptions
): void {
  if (options.startupAgent && selector === undefined) {
    throw new Error(`startupAgent ${options.startupAgent} requires a workspace selector.`)
  }
  if (options.deferredStartupOperationId === undefined) {
    return
  }
  if (!options.deferredStartupOperationId.trim() || !options.command?.trim()) {
    throw new Error('deferred_startup_requires_command_and_operation')
  }
  if (
    !selector ||
    options.rendererBacked ||
    options.focus ||
    options.presentation === 'focused' ||
    options.preAllocatedHandle ||
    options.sessionId ||
    options.tabId ||
    options.leafId ||
    options.agentSessionClaim ||
    options.agentSessionCreateOperationId
  ) {
    throw new Error('deferred_startup_requires_fresh_background_terminal')
  }
}

export async function assertDeferredProvider(
  options: TerminalCreateOptions,
  controller: RuntimePtyController,
  connectionId: string | null
): Promise<void> {
  if (
    options.deferredStartupOperationId !== undefined &&
    (!controller.releaseStartupCommand ||
      (await controller.supportsDeferredStartupCommands?.(connectionId)) !== true)
  ) {
    throw new Error('deferred_startup_unavailable')
  }
}
