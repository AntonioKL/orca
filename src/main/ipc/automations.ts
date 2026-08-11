import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  ExternalAutomationRunsPage,
  AutomationRun,
  AutomationUpdateInput
} from '../../shared/automations-types'
import {
  automationChangePublications,
  type AutomationChangeSelector,
  type AutomationListParams,
  type AutomationListResult
} from '../../shared/automation-list-scope'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../shared/automation-owner-precondition'
import { createScopedExternalAutomations } from '../automations/external-manager'
import { runAutomationNowFenced } from '../automations/refused-manual-run'
import {
  ExternalAutomationManagerCache,
  type ExternalAutomationManagerCacheEntry
} from '../automations/external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from '../automations/external-automation-probe-scheduler'
import { ownerKey } from '../../shared/automation-owner-key'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
} from '../../shared/external-automation-scope'

/**
 * Publishes the scoped `automationsChanged` events one definition change owes.
 *
 * A move touches two hosts, so both are named; an unknown side degrades the
 * whole publication to one unscoped authority event rather than a partial one,
 * because a subscriber that never hears about the host it is showing would keep
 * a deleted row on screen.
 */
function publishDefinitionChange(
  service: AutomationService,
  before: AutomationChangeSelector | null,
  after: AutomationChangeSelector | null
): void {
  for (const selector of automationChangePublications(before, after)) {
    service.publishAutomationsChanged({ reason: 'definition', ...(selector ? { selector } : {}) })
  }
}

/**
 * Fail closed: an external request with no captured owner is refused rather than
 * resolved against whichever host happens to be active. Malformed input keeps
 * the engine's plain-Error convention; it is not an ownership *conflict*.
 */
function requireCapturedOwner<T extends { owner?: AutomationOwnerRef | null }>(
  request: T | null | undefined
): T {
  const owner = request?.owner
  if (!request || !owner || !owner.authority || !owner.selector) {
    throw new Error('An automation owner is required for external automation requests.')
  }
  return request
}

/**
 * Holds the probe pool's priority lease for the duration of Orca's own automation
 * work. Without this, a queued external probe competes with the list and mutation
 * traffic the user is actually waiting on.
 */
function underOrcaPriority<T>(scheduler: ExternalAutomationProbeScheduler, run: () => T): T {
  const release = scheduler.beginPriorityWork()
  let pending = false
  try {
    const result = run()
    if (result instanceof Promise) {
      pending = true
      return result.finally(release) as T
    }
    return result
  } finally {
    if (!pending) {
      release()
    }
  }
}

export function registerAutomationHandlers(store: Store, service: AutomationService): void {
  // One long-lived pair per registration: the cache TTL and the probe pool's
  // concurrency ceiling only mean anything if they outlive a single request.
  const probeScheduler = new ExternalAutomationProbeScheduler()
  const managerCache = new ExternalAutomationManagerCache()
  const scopedExternal = createScopedExternalAutomations({
    // Hidden runtime-owned targets are passed through on purpose: the guard
    // rejects them itself, so pre-filtering here would leak a different error.
    registry: { getSshTargets: () => store.getSshTargets() },
    scheduler: probeScheduler,
    cache: managerCache
  })
  const withPriority = <T>(run: () => T): T => underOrcaPriority(probeScheduler, run)
  // Why: an omitted selector keeps the legacy array so existing callers are untouched.
  ipcMain.handle(
    'automations:list',
    (_event, params?: AutomationListParams | null): Automation[] | AutomationListResult =>
      withPriority(() =>
        params?.selector ? store.listAutomationsForScope(params) : store.listAutomations()
      )
  )
  ipcMain.handle(
    'automations:listRuns',
    (
      _event,
      args?: { automationId?: string; expectedOwner?: AutomationOwnerPrecondition }
    ): AutomationRun[] =>
      withPriority(() => {
        if (args?.automationId && args.expectedOwner) {
          store.assertAutomationOwnerFence({
            id: args.automationId,
            expectedOwner: args.expectedOwner,
            operation: 'read'
          })
        }
        return store.listAutomationRuns(args?.automationId)
      })
  )
  // Scoped external-manager surface: one captured desktop owner in, one host's
  // managers out. The target and manager ID are derived inside the guard.
  ipcMain.handle(
    'automations:listExternalManagerForOwner',
    (
      _event,
      request: ScopedExternalManagerListRequest
    ): Promise<ExternalAutomationManagerCacheEntry> =>
      scopedExternal.listManager(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:listExternalRunsForOwner',
    (_event, request: ScopedExternalManagerRunsRequest): Promise<ExternalAutomationRunsPage> =>
      scopedExternal.listRuns(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:createExternalForOwner',
    (_event, request: ScopedExternalManagerCreateRequest): Promise<void> =>
      scopedExternal.create(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:updateExternalForOwner',
    (_event, request: ScopedExternalManagerUpdateRequest): Promise<void> =>
      scopedExternal.update(requireCapturedOwner(request))
  )
  ipcMain.handle(
    'automations:runExternalActionForOwner',
    (_event, request: ScopedExternalManagerActionRequest): Promise<void> =>
      scopedExternal.runAction(requireCapturedOwner(request))
  )
  // Why: probes for hosts the user is no longer viewing are cancelled, not left
  // to finish. An empty list retains nothing, which is the correct fail-closed
  // state for a renderer with no desktop scope selected.
  ipcMain.handle(
    'automations:retainExternalScopes',
    (_event, request?: { owners?: readonly AutomationOwnerRef[] } | null): void => {
      probeScheduler.retainScopes((request?.owners ?? []).map(ownerKey))
    }
  )
  ipcMain.handle(
    'automations:create',
    (
      _event,
      input: AutomationCreateInput,
      options?: { destination?: AutomationDestination }
    ): Automation =>
      withPriority(() => {
        const created = store.createAutomation(input, options)
        const selector = store.automationChangeSelector(created.id)
        publishDefinitionChange(service, selector, selector)
        return created
      })
  )
  ipcMain.handle(
    'automations:update',
    (
      _event,
      args: {
        id: string
        updates: AutomationUpdateInput
        expectedOwner?: AutomationOwnerPrecondition
        destination?: AutomationDestination
      }
    ): Automation =>
      withPriority(() => {
        // Captured first: an update may move the record to another host.
        const before = store.automationChangeSelector(args.id)
        const updated = store.updateAutomation(args.id, args.updates, {
          expectedOwner: args.expectedOwner,
          destination: args.destination
        })
        publishDefinitionChange(service, before, store.automationChangeSelector(args.id))
        return updated
      })
  )
  ipcMain.handle(
    'automations:delete',
    (_event, args: { id: string; expectedOwner?: AutomationOwnerPrecondition }): void =>
      withPriority(() => {
        const before = store.automationChangeSelector(args.id)
        store.deleteAutomation(args.id, { expectedOwner: args.expectedOwner })
        publishDefinitionChange(service, before, before)
      })
  )
  ipcMain.handle(
    'automations:runNow',
    (
      _event,
      args: { id: string; expectedOwner?: AutomationOwnerPrecondition }
    ): Promise<AutomationRun> =>
      withPriority(() =>
        // Why: the dispatch is refused before a session exists, exactly like the runtime path.
        runAutomationNowFenced({
          fence: () =>
            store.assertAutomationOwnerFence({
              id: args.id,
              expectedOwner: args.expectedOwner,
              operation: 'execute'
            }),
          service,
          automationId: args.id
        })
      )
  )
  ipcMain.handle(
    'automations:runPrecheck',
    (
      _event,
      args: { automationId: string; runId: string }
    ): Promise<AutomationPrecheckResult | null> =>
      service.runPrecheck(args.automationId, args.runId)
  )
  ipcMain.handle(
    'automations:markDispatchResult',
    (_event, result: AutomationDispatchResult): Promise<AutomationRun> =>
      service.markDispatchResult(result)
  )
  ipcMain.handle(
    'automations:snapshotWorkspaceName',
    (_event, args: { workspaceId: string; displayName: string }): number =>
      store.snapshotAutomationRunWorkspaceDisplayName(args.workspaceId, args.displayName)
  )
  ipcMain.handle('automations:rendererReady', (): void => {
    service.setRendererReady()
  })
}
