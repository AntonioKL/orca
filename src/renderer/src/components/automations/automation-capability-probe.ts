import { getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { automationHostDiagnostics } from './automation-host-diagnostics'

export const REQUEST_TIMEOUT_MS = 15_000

export class AutomationHostScopeUnsupportedError extends Error {
  readonly code = 'unsupported_host_scope'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationHostScopeUnsupportedError'
  }
}

export const AUTHORITY_CAPABILITY_CONFIRMATION_TTL_MS = 60_000
export const AUTHORITY_CAPABILITY_CONFIRMATION_MAX = 32
const confirmedAuthorityCapabilities = new Map<
  string,
  { capabilities: Set<string>; confirmedAt: number }
>()
const inFlightCapabilityProbes = new Map<string, Promise<{ capabilities?: string[] }>>()

function capabilityProbeKey(authority: AutomationAuthorityRef & { kind: 'runtime' }): string {
  return `${authority.environmentId}:${authority.pairingRevision}`
}

function rememberAuthorityCapabilities(
  key: string,
  capabilities: Set<string>,
  confirmedAt: number
): void {
  confirmedAuthorityCapabilities.delete(key)
  confirmedAuthorityCapabilities.set(key, { capabilities, confirmedAt })
  while (confirmedAuthorityCapabilities.size > AUTHORITY_CAPABILITY_CONFIRMATION_MAX) {
    const oldest = confirmedAuthorityCapabilities.keys().next()
    if (oldest.done) {
      break
    }
    confirmedAuthorityCapabilities.delete(oldest.value)
  }
}

/** Test seam: capability state is module-level and must not leak between tests. */
export function resetAutomationCapabilityProbes(): void {
  confirmedAuthorityCapabilities.clear()
  inFlightCapabilityProbes.clear()
}

export async function assertAuthorityCapability(
  authority: AutomationAuthorityRef,
  capability: RuntimeCapability,
  message: string,
  options: { cacheConfirmation?: boolean } = {}
): Promise<void> {
  if (authority.kind !== 'runtime') {
    return
  }
  const key = capabilityProbeKey(authority)
  if (options.cacheConfirmation !== false) {
    const confirmation = confirmedAuthorityCapabilities.get(key)
    if (
      confirmation &&
      Date.now() - confirmation.confirmedAt >= AUTHORITY_CAPABILITY_CONFIRMATION_TTL_MS
    ) {
      confirmedAuthorityCapabilities.delete(key)
    } else if (confirmation?.capabilities.has(capability)) {
      return
    }
  }
  let probe = inFlightCapabilityProbes.get(key)
  if (!probe) {
    automationHostDiagnostics.recordCapabilityProbe({
      authorityKey: automationAuthorityCatalogKey(authority)
    })
    const started = getRuntimeEnvironmentStatus(authority.environmentId, REQUEST_TIMEOUT_MS)
    probe = started
    inFlightCapabilityProbes.set(key, started)
    void started
      .catch(() => undefined)
      .finally(() => {
        if (inFlightCapabilityProbes.get(key) === started) {
          inFlightCapabilityProbes.delete(key)
        }
      })
  }
  const status = await probe
  if (options.cacheConfirmation !== false && status.capabilities?.length) {
    rememberAuthorityCapabilities(key, new Set(status.capabilities), Date.now())
  }
  if (!status.capabilities?.includes(capability)) {
    throw new AutomationHostScopeUnsupportedError(message)
  }
}

export async function assertOwnerFencingSupported(
  authority: AutomationAuthorityRef
): Promise<void> {
  await assertAuthorityCapability(
    authority,
    AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
    AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE,
    { cacheConfirmation: false }
  )
}

export {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE
}
