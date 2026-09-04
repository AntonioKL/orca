import type { RuntimeCapability } from '../../../shared/protocol-version'

let localRuntimeCapabilities: readonly RuntimeCapability[] = []
let localRuntimeHostPlatform: NodeJS.Platform | null = null
let refreshPromise: Promise<readonly RuntimeCapability[]> | null = null

export function readLocalRuntimeCapabilities(): readonly RuntimeCapability[] {
  return localRuntimeCapabilities
}

export function readLocalRuntimeHostPlatform(): NodeJS.Platform | null {
  return localRuntimeHostPlatform
}

export function refreshLocalRuntimeCapabilities(): Promise<readonly RuntimeCapability[]> {
  refreshPromise ??= window.api.runtime
    .getStatus()
    .then((status) => {
      localRuntimeCapabilities = [...(status.capabilities ?? [])]
      localRuntimeHostPlatform = status.hostPlatform ?? null
      return localRuntimeCapabilities
    })
    .catch(() => {
      localRuntimeCapabilities = []
      localRuntimeHostPlatform = null
      return localRuntimeCapabilities
    })
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

export function setLocalRuntimeCapabilitiesForTests(
  capabilities: readonly RuntimeCapability[],
  hostPlatform: NodeJS.Platform | null = null
): void {
  localRuntimeCapabilities = [...capabilities]
  localRuntimeHostPlatform = hostPlatform
  refreshPromise = null
}
