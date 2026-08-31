const diagnosticsGenerationByEnvironment = new Map<string, number>()

export function acceptRuntimeEnvironmentDiagnosticsGeneration(
  environmentId: string,
  transportGeneration: number
): boolean {
  const previous = diagnosticsGenerationByEnvironment.get(environmentId)
  if (previous !== undefined && transportGeneration < previous) {
    return false
  }
  diagnosticsGenerationByEnvironment.set(environmentId, transportGeneration)
  return true
}

export function clearRuntimeEnvironmentDiagnosticsGenerationsForTests(): void {
  diagnosticsGenerationByEnvironment.clear()
}

export function mergePushedRuntimeEnvironmentDiagnostics(args: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
  current: RuntimeEnvironmentStatus | undefined
  publish: (status: RuntimeEnvironmentStatus) => void
}): void {
  if (
    !acceptRuntimeEnvironmentDiagnosticsGeneration(args.environmentId, args.transportGeneration) ||
    !args.current?.status
  ) {
    return
  }
  args.publish({
    ...args.current,
    status: { ...args.current.status, remoteControl: args.diagnostics }
  })
}
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import type { RuntimeEnvironmentStatus } from './runtime-status'
