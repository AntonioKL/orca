/**
 * Owner-qualified automation requests for one authority.
 *
 * Every call carries the incarnation the caller captured: a runtime request is
 * pinned to its `pairingRevision` through the existing environment revision
 * guard, and an SSH-scoped request carries the registration generation the row
 * was fetched under. Responses are validated, never cast — an older host that
 * silently drops the selector answers with its whole authority, and committing
 * that would attribute other hosts' automations to the selected one.
 */

import {
  callRuntimeRpc,
  getRuntimeEnvironmentStatus,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type {
  AutomationListResult,
  AutomationListScopeSelector
} from '../../../../shared/automation-list-scope'
import { validateAutomationListResponse } from '../../../../shared/automation-list-response'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
/** The one classifier every client shares; re-exported so call sites keep importing it from here. */
export { matchAutomationOwnerConflict } from '../../../../shared/automation-owner-conflict'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../../../shared/automation-owner-precondition'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import {
  toRuntimeAutomationCreateInput,
  toRuntimeAutomationUpdateInput
} from './automation-host-client'
import { automationHostDiagnostics } from './automation-host-diagnostics'

const REQUEST_TIMEOUT_MS = 15_000

export class AutomationHostScopeUnsupportedError extends Error {
  readonly code = 'unsupported_host_scope'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationHostScopeUnsupportedError'
  }
}

export class AutomationListResponseError extends Error {
  readonly code = 'invalid_response'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationListResponseError'
  }
}

export type ScopedAutomationList = AutomationListResult & {
  /** Rows dropped because their metadata was missing, duplicated, or scoped elsewhere. */
  invalidRows: number
}

function runtimeTarget(authority: AutomationAuthorityRef): RuntimeClientTarget {
  return authority.kind === 'desktop'
    ? { kind: 'local' }
    : { kind: 'environment', environmentId: authority.environmentId }
}

function scopeSelector(owner: AutomationOwnerRef): AutomationListScopeSelector {
  return owner.selector.kind === 'ssh'
    ? {
        kind: 'ssh',
        targetId: owner.selector.targetId,
        expectedTargetGeneration: owner.selector.targetGeneration
      }
    : { kind: 'self' }
}

/** Orphan rows have a known authority and no executable owner, so delete/pause fence on that instead. */
export const ORPHAN_OWNER_PRECONDITION: AutomationOwnerPrecondition = {
  selector: { kind: 'orphan' }
}

export function ownerPrecondition(owner: AutomationOwnerRef): AutomationOwnerPrecondition {
  return {
    selector:
      owner.selector.kind === 'ssh'
        ? {
            kind: 'ssh',
            targetId: owner.selector.targetId,
            targetGeneration: owner.selector.targetGeneration
          }
        : { kind: 'self' }
  }
}

async function callAuthority<TResult>(
  authority: AutomationAuthorityRef,
  method: string,
  params: unknown
): Promise<TResult> {
  return await callRuntimeRpc<TResult>(runtimeTarget(authority), method, params, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Why: a same-id re-pair must invalidate this request instead of retargeting it.
    ...(authority.kind === 'runtime'
      ? { expectedEnvironmentPairingRevision: authority.pairingRevision }
      : {})
  })
}

/**
 * One probe serves an incarnation, not a call: concurrent callers share the
 * in-flight `status.get`, and a capability a response confirmed is never asked
 * about again under the same pairing revision. Only confirmations are kept — an
 * absence or a failed probe is asked again on the next call, so a server
 * upgraded in place recovers without a re-pair.
 */
const confirmedAuthorityCapabilities = new Map<string, Set<string>>()
const inFlightCapabilityProbes = new Map<string, Promise<{ capabilities?: string[] }>>()

function capabilityProbeKey(authority: AutomationAuthorityRef & { kind: 'runtime' }): string {
  return `${authority.environmentId}:${authority.pairingRevision}`
}

/** Test seam: probe state is module-level and must not leak between test cases. */
export function resetAutomationCapabilityProbes(): void {
  confirmedAuthorityCapabilities.clear()
  inFlightCapabilityProbes.clear()
}

/**
 * Fails closed on a missing capability, but only on a *known* absence: an
 * unreachable authority must classify as unavailable and retry, not as an old
 * server the user is told to upgrade.
 *
 * The probe is counted where it is sent because it is counted nowhere else: it
 * rides outside the scheduler's four-slot pool, so an instrument that saw only
 * pooled work would under-report the relay traffic a 50-host refresh costs.
 */
async function assertAuthorityCapability(
  authority: AutomationAuthorityRef,
  capability: RuntimeCapability,
  message: string
): Promise<void> {
  if (authority.kind !== 'runtime') {
    return
  }
  const key = capabilityProbeKey(authority)
  if (confirmedAuthorityCapabilities.get(key)?.has(capability)) {
    return
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
  if (status.capabilities?.length) {
    const confirmed = confirmedAuthorityCapabilities.get(key) ?? new Set<string>()
    for (const name of status.capabilities) {
      confirmed.add(name)
    }
    confirmedAuthorityCapabilities.set(key, confirmed)
  }
  if (!status.capabilities?.includes(capability)) {
    throw new AutomationHostScopeUnsupportedError(message)
  }
}

async function assertOwnerFencingSupported(authority: AutomationAuthorityRef): Promise<void> {
  await assertAuthorityCapability(
    authority,
    AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
    AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE
  )
}

function validated(raw: unknown, selector: AutomationListScopeSelector): ScopedAutomationList {
  const validation = validateAutomationListResponse(raw, selector)
  if (!validation.ok) {
    throw validation.error.code === 'unsupported_host_scope'
      ? new AutomationHostScopeUnsupportedError(validation.error.message)
      : new AutomationListResponseError(validation.error.message)
  }
  return { ...validation.result, invalidRows: validation.invalidRows }
}

export async function listScopedAutomations(
  authority: AutomationAuthorityRef,
  selector: AutomationListScopeSelector
): Promise<ScopedAutomationList> {
  // Why: the desktop authority is the in-process runtime, so the probe no-ops
  // there — its scoped contract ships with the client and can never lag it.
  await assertAuthorityCapability(
    authority,
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE
  )
  return validated(await callAuthority(authority, 'automation.list', { selector }), selector)
}

/**
 * The one unscoped request an old runtime gets per refresh cycle. Its result is
 * partitioned client-side into every requested entry; it carries no owners and
 * no usage projection, so those rows stay view-only.
 */
export async function listLegacyAutomations(
  authority: AutomationAuthorityRef
): Promise<Automation[]> {
  if (authority.kind === 'desktop') {
    // Desktop storage ships the scoped contract in-process, so it never degrades.
    throw new AutomationListResponseError('The desktop authority always supports scoped lists.')
  }
  const raw = await callAuthority<unknown>(authority, 'automation.list', null)
  const automations = (raw as { automations?: unknown } | null)?.automations
  if (!Array.isArray(automations)) {
    throw new AutomationListResponseError('The host returned an unreadable automation list.')
  }
  return automations as Automation[]
}

/** Convenience wrapper for a row's own host; orphan scopes are requested with the selector form. */
export async function listAutomationsForOwner(
  owner: AutomationOwnerRef
): Promise<ScopedAutomationList> {
  return await listScopedAutomations(owner.authority, scopeSelector(owner))
}

/**
 * Deliberately unprobed, matching the mutation arms' *absence* of a probe here:
 * history is read-only, and an older host that ignores the precondition answers
 * with the rows it has rather than acting on a fence it never honoured.
 */
async function listRunsFenced(
  authority: AutomationAuthorityRef,
  automationId: string,
  expectedOwner: AutomationOwnerPrecondition
): Promise<AutomationRun[]> {
  const result = await callAuthority<{ runs: AutomationRun[] }>(authority, 'automation.runs', {
    automationId,
    expectedOwner
  })
  return result.runs
}

export async function listAutomationRunsForOwner(
  owner: AutomationOwnerRef,
  automationId: string
): Promise<AutomationRun[]> {
  return await listRunsFenced(owner.authority, automationId, ownerPrecondition(owner))
}

/**
 * The one fenced-mutation path every authority shares. Owned and orphan rows
 * differ in the precondition they fence with and in nothing else, so they
 * share the transport, the capability probe, and any check either later gains.
 */
async function updateFenced(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput,
  expectedOwner: AutomationOwnerPrecondition,
  destination?: AutomationDestination
): Promise<Automation> {
  await assertOwnerFencingSupported(authority)
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.update', {
    id,
    updates: toRuntimeAutomationUpdateInput(updates),
    expectedOwner,
    destination
  })
  return result.automation
}

async function deleteFenced(
  authority: AutomationAuthorityRef,
  id: string,
  expectedOwner: AutomationOwnerPrecondition
): Promise<void> {
  await assertOwnerFencingSupported(authority)
  await callAuthority(authority, 'automation.delete', { id, expectedOwner })
}

export async function updateAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string,
  updates: AutomationUpdateInput,
  destination?: AutomationDestination
): Promise<Automation> {
  return await updateFenced(owner.authority, id, updates, ownerPrecondition(owner), destination)
}

export async function deleteAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<void> {
  await deleteFenced(owner.authority, id, ownerPrecondition(owner))
}

/**
 * Orphan rows have no owner to key by, so the orphan precondition is the fence.
 * The authority is still known and still probed: an orphan on an out-of-date
 * host is refused for the same reason an owned row there is.
 *
 * No destination is accepted — moving a row needs a host it can move to.
 */
export async function updateOrphanAutomation(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput
): Promise<Automation> {
  return await updateFenced(authority, id, updates, ORPHAN_OWNER_PRECONDITION)
}

export async function deleteOrphanAutomation(
  authority: AutomationAuthorityRef,
  id: string
): Promise<void> {
  await deleteFenced(authority, id, ORPHAN_OWNER_PRECONDITION)
}

/**
 * An orphan keeps its history: reading past runs needs no host to run on, which
 * is why `ORPHAN_ACTIONS` allows it where execution is blocked.
 */
export async function listOrphanAutomationRuns(
  authority: AutomationAuthorityRef,
  automationId: string
): Promise<AutomationRun[]> {
  return await listRunsFenced(authority, automationId, ORPHAN_OWNER_PRECONDITION)
}

export async function runAutomationNowForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<AutomationRun> {
  await assertOwnerFencingSupported(owner.authority)
  const expectedOwner = ownerPrecondition(owner)
  const result = await callAuthority<{ run: AutomationRun }>(owner.authority, 'automation.runNow', {
    id,
    expectedOwner
  })
  return result.run
}

export async function createAutomationForDestination(
  authority: AutomationAuthorityRef,
  input: AutomationCreateInput,
  destination: AutomationDestination
): Promise<Automation> {
  await assertOwnerFencingSupported(authority)
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.create', {
    ...toRuntimeAutomationCreateInput(input),
    destination
  })
  return result.automation
}
