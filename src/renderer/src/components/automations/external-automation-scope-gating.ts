/**
 * Whether a host's external automation managers are actually listed.
 *
 * External managers are a desktop-authority surface this release, so most hosts
 * are *scope limited* rather than empty. The distinction is load-bearing: a
 * runtime-owned host with no rows has not been probed, and presenting it as
 * clean would tell the user something we did not check.
 */

import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  type ExternalAutomationScopeCode
} from '../../../../shared/external-automation-scope'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { translate } from '@/i18n/i18n'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'

export type ExternalAutomationScopeStatus = 'listed' | 'not-listed' | 'unknown'

export type ExternalAutomationScopeGate = {
  status: ExternalAutomationScopeStatus
  /** Non-null only when `listed`; every other status must not probe. */
  probeOwner: AutomationOwnerRef | null
  /** Engine code when one explains the limit; null when no owner was captured. */
  code: ExternalAutomationScopeCode | null
}

const UNKNOWN_GATE: ExternalAutomationScopeGate = {
  status: 'unknown',
  probeOwner: null,
  code: null
}

function notListed(code: ExternalAutomationScopeCode | null): ExternalAutomationScopeGate {
  return { status: 'not-listed', probeOwner: null, code }
}

/**
 * Resolves one host. A null entry is the unresolved/All-hosts case and makes no
 * claim either way; compose per-host gates for All hosts instead.
 */
export function resolveExternalAutomationScopeGate(
  entry: AutomationHostCatalogEntry | null
): ExternalAutomationScopeGate {
  if (!entry) {
    return UNKNOWN_GATE
  }
  if (entry.stableRef.authority.kind !== 'desktop') {
    return notListed(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
  }
  if (entry.kind === 'orphan') {
    return notListed(null)
  }
  // Fail closed: an uncaptured owner cannot be probed, so nothing is listed for it.
  return entry.owner ? { status: 'listed', probeOwner: entry.owner, code: null } : notListed(null)
}

/** The value `AutomationListEmptyView` requires; never derived from row counts. */
export function externalManagersListedForEntry(entry: AutomationHostCatalogEntry | null): boolean {
  return resolveExternalAutomationScopeGate(entry).status === 'listed'
}

/**
 * All-hosts variant: one scope-limited host in the view is enough to keep the
 * note on screen, because the combined list is then incomplete.
 */
export function externalManagersListedForEntries(
  entries: readonly AutomationHostCatalogEntry[]
): boolean {
  return entries.length > 0 && entries.every((entry) => externalManagersListedForEntry(entry))
}

/**
 * The hosts whose external managers are in view. Probing and retention both key
 * off this: a host the user filtered away is not a host we may go ask about.
 */
export function externalAutomationScopeEntries(
  entries: readonly AutomationHostCatalogEntry[],
  resolution: AutomationHostFilterResolution
): readonly AutomationHostCatalogEntry[] {
  if (resolution.effective.kind === 'all') {
    return entries
  }
  return resolution.entry ? [resolution.entry] : []
}

/** Owners the probe pool may keep working on; everything else is cancelled. */
export function externalAutomationProbeOwners(
  entries: readonly AutomationHostCatalogEntry[]
): AutomationOwnerRef[] {
  const owners: AutomationOwnerRef[] = []
  for (const entry of entries) {
    const gate = resolveExternalAutomationScopeGate(entry)
    if (gate.probeOwner) {
      owners.push(gate.probeOwner)
    }
  }
  return owners
}

/**
 * The scope-limitation line. Shown in the populated state too — the empty state
 * is not the only place a host can be silently incomplete.
 */
export function externalAutomationScopeNotice(gate: ExternalAutomationScopeGate): string | null {
  if (gate.status !== 'not-listed') {
    return null
  }
  if (gate.code === EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden) {
    return translate(
      'auto.components.automations.externalScope.targetHidden',
      'This host is managed by Orca, so its external automation managers are not listed in this release.'
    )
  }
  // Same string as the empty state's scope note, so the two never drift apart.
  return translate(
    'auto.components.automations.emptyState.externalManagersOutOfScope',
    'External automation managers are not listed for this host in this release.'
  )
}

/**
 * Maps a rejected scoped call onto a gate. The engine carries its code as a
 * trailing `: <code>` token because IPC preserves nothing but the message.
 */
export function externalAutomationScopeGateFromError(
  error: unknown
): ExternalAutomationScopeGate | null {
  const code = parseExternalAutomationScopeCode(error)
  return code ? notListed(code) : null
}

export function parseExternalAutomationScopeCode(
  error: unknown
): ExternalAutomationScopeCode | null {
  const message = (error instanceof Error ? error.message : String(error ?? '')).trimEnd()
  for (const code of Object.values(EXTERNAL_AUTOMATION_SCOPE_CODES)) {
    if (message.endsWith(`: ${code}`)) {
      return code
    }
  }
  return null
}
