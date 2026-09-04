import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import { ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  refreshOrchestrationFleetLivenessAttention,
  type FleetDurableWorker,
  type OrchestrationFleetPage
} from '../../../../../../shared/orchestration-fleet-projection'
import { projectFleetNextAction } from '../../../../../../shared/orchestration-fleet-worker-projection'
import { getOrchestrationPeerCapabilityCache } from '../../../../orchestration/orchestration-peer-capability-cache'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolvePinnedFederatedServer } from '../worker/worker-observation'

const FLEET_HOST_CONCURRENCY = 4
const FLEET_HOST_TIMEOUT_MS = 3_000
const FLEET_TOTAL_TIMEOUT_MS = 5_000

export type FederatedFleetObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  exactWorker: boolean
  reason?: string
}

export type FederatedFleetHostError = {
  environmentId: string
  name: string
  code: 'capability_unsupported' | 'host_unavailable' | 'home_budget_exhausted' | 'peer_changed'
  dispatchIds: string[]
}

type HostGroup = {
  environmentId: string
  name: string
  dispatches: FederatedDispatchRow[]
}

export async function readFederatedFleetSnapshots(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchIds: readonly string[]
}): Promise<{
  observations: Map<string, FederatedFleetObservation>
  errors: FederatedFleetHostError[]
  hosts: Map<string, string>
}> {
  const groups = groupFederatedDispatches(args)
  const deadline = Date.now() + FLEET_TOTAL_TIMEOUT_MS
  const results = await mapWithConcurrency(groups, FLEET_HOST_CONCURRENCY, async (group) => {
    const dispatchIds = group.dispatches.map((dispatch) => dispatch.dispatch_id)
    const observationFences = args.db.captureFederatedDispatchObservationFences(dispatchIds)
    const error = (code: FederatedFleetHostError['code']): FederatedFleetHostError => ({
      environmentId: group.environmentId,
      name: group.name,
      code,
      dispatchIds
    })
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // Orca never contacted this host; that is a home-side budget fact, not host silence.
      return { observations: [], error: error('home_budget_exhausted') }
    }
    const timeoutMs = Math.min(FLEET_HOST_TIMEOUT_MS, remaining)
    const first = group.dispatches[0]
    const cache = getOrchestrationPeerCapabilityCache(args.runtime)
    let observedCapabilityEpoch: string | null = null
    try {
      const server = resolvePinnedFederatedServer(args.runtime, first)
      // `method_not_found` is the single downgrade signal; a status probe would spend the
      // fleet budget on a round trip that still misses hosts serving the unadvertised method.
      const known = cache.knownSupport(
        first.peer_fingerprint,
        first.remote_runtime_epoch,
        ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY
      )
      observedCapabilityEpoch = known?.runtimeEpoch ?? first.remote_runtime_epoch
      if (known?.supported === false) {
        if (observedCapabilityEpoch) {
          projectFleetRuntimeEpochs(args.db, observationFences, observedCapabilityEpoch)
        }
        return { observations: [], error: error('capability_unsupported') }
      }
      const snapshotRemainingMs = deadline - Date.now()
      if (snapshotRemainingMs <= 0) {
        return { observations: [], error: error('home_budget_exhausted') }
      }
      const snapshot = (await args.runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationFleetSnapshot',
        { dispatchIds },
        Math.min(timeoutMs, snapshotRemainingMs),
        undefined,
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )) as {
        runtimeEpoch: string
        items: { dispatchId: string; observation: FederatedFleetObservation }[]
      }
      cache.remember(
        first.peer_fingerprint,
        snapshot.runtimeEpoch,
        ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
        true
      )
      const projectedDispatches = projectFleetRuntimeEpochs(
        args.db,
        observationFences,
        snapshot.runtimeEpoch
      )
      const expected = new Set(dispatchIds)
      return {
        observations: snapshot.items
          .filter(
            (item) => expected.has(item.dispatchId) && projectedDispatches.has(item.dispatchId)
          )
          .map((item) =>
            item.observation.exactWorker
              ? item
              : {
                  ...item,
                  // A non-exact identity can never prove either liveness or exit.
                  observation: { ...item.observation, status: 'unverifiable' as const }
                }
          ),
        error: null
      }
    } catch (caught) {
      if (caught instanceof OrchestrationError && caught.code === 'method_not_found') {
        cache.remember(
          first.peer_fingerprint,
          observedCapabilityEpoch ?? first.remote_runtime_epoch ?? 'unknown',
          ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
          false
        )
        if (observedCapabilityEpoch) {
          projectFleetRuntimeEpochs(args.db, observationFences, observedCapabilityEpoch)
        }
        return { observations: [], error: error('capability_unsupported') }
      }
      // The environment was repointed at another Orca server; that is an identity fact, not silence.
      return {
        observations: [],
        error: error(
          caught instanceof OrchestrationError && caught.code === 'peer_changed'
            ? 'peer_changed'
            : 'host_unavailable'
        )
      }
    }
  })
  const observations = new Map<string, FederatedFleetObservation>()
  const errors: FederatedFleetHostError[] = []
  const hosts = new Map<string, string>()
  for (const group of groups) {
    for (const dispatch of group.dispatches) {
      hosts.set(dispatch.dispatch_id, group.environmentId)
    }
  }
  for (const result of results) {
    for (const item of result.observations) {
      observations.set(item.dispatchId, item.observation)
    }
    if (result.error) {
      errors.push(result.error)
    }
  }
  return { observations, errors, hosts }
}

function projectFleetRuntimeEpochs(
  db: OrchestrationDb,
  fences: Map<
    string,
    NonNullable<ReturnType<OrchestrationDb['captureFederatedDispatchObservationFence']>>
  >,
  runtimeEpoch: string
): Set<string> {
  const projectedDispatches = new Set<string>()
  for (const [dispatchId, fence] of fences) {
    if (
      db.projectFederatedDispatchObservation(fence, () => {
        db.updateFederatedDispatchRuntimeEpoch(dispatchId, runtimeEpoch)
      })
    ) {
      projectedDispatches.add(dispatchId)
    }
  }
  return projectedDispatches
}

export function applyFederatedFleetObservations(
  fleet: OrchestrationFleetPage,
  federated: Awaited<ReturnType<typeof readFederatedFleetSnapshots>>,
  durable: ReadonlyMap<string, FleetDurableWorker>,
  observedAt = Date.now()
): void {
  const unavailableDispatches = new Map(
    federated.errors.flatMap((error) =>
      error.dispatchIds.map(
        (dispatchId) => [dispatchId, unavailableLivenessReason(error.code)] as const
      )
    )
  )
  for (const worker of fleet.workers) {
    const hostId = federated.hosts.get(worker.dispatchId)
    if (hostId) {
      worker.host = { kind: 'remote', id: hostId }
    }
    const observation = federated.observations.get(worker.dispatchId)
    if (!observation) {
      const unavailableReason = unavailableDispatches.get(worker.dispatchId)
      if (unavailableReason) {
        if (worker.liveness.verdict === 'exited') {
          continue
        }
        worker.liveness = { verdict: 'unverifiable', reason: unavailableReason }
        worker.evidence.liveStatus = 'unavailable'
        worker.evidence.lastObservedAt = null
        refreshFleetWorkerVerdict(worker, durable)
      }
      continue
    }
    if (worker.liveness.verdict === 'exited' && observation.status !== 'exited') {
      continue
    }
    worker.liveness =
      observation.status === 'live'
        ? { verdict: 'live', observedAt, source: 'execution_host' }
        : observation.status === 'exited'
          ? { verdict: 'exited', source: 'execution_host' }
          : { verdict: 'unverifiable', reason: hostReportedReason(observation.reason) }
    worker.evidence.liveStatus = observation.status === 'live' ? 'fresh' : 'unavailable'
    // The host answered for both `live` and `exited`, so both carry a real observation time.
    worker.evidence.lastObservedAt = observation.status === 'unverifiable' ? null : observedAt
    refreshFleetWorkerVerdict(worker, durable)
  }
}

/** The host verdict replaces the local one, so everything derived from liveness has to
 *  follow it: a stale `inspect` outranked the `recover` a proven remote exit owes. */
function refreshFleetWorkerVerdict(
  worker: OrchestrationFleetPage['workers'][number],
  durable: ReadonlyMap<string, FleetDurableWorker>
): void {
  refreshOrchestrationFleetLivenessAttention(worker)
  const row = durable.get(worker.dispatchId)
  if (row) {
    worker.nextAction = projectFleetNextAction(row, worker.liveness)
  }
}

function unavailableLivenessReason(
  code: FederatedFleetHostError['code']
): 'home_budget_exhausted' | 'peer_changed' | 'host_unavailable' {
  return code === 'home_budget_exhausted' || code === 'peer_changed' ? code : 'host_unavailable'
}

const HOST_REPORTED_REASONS = new Set([
  'missing_status',
  'stale_status',
  'future_status',
  'restored_unconfirmed'
])

/** The host answered; contact was never lost, so never relabel its verdict as host_unavailable. */
function hostReportedReason(
  reason: string | undefined
):
  | 'host_indeterminate'
  | 'missing_status'
  | 'stale_status'
  | 'future_status'
  | 'restored_unconfirmed' {
  return reason && HOST_REPORTED_REASONS.has(reason)
    ? (reason as 'missing_status' | 'stale_status' | 'future_status' | 'restored_unconfirmed')
    : 'host_indeterminate'
}

function groupFederatedDispatches(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchIds: readonly string[]
}): HostGroup[] {
  const groups = new Map<string, HostGroup>()
  const federatedByDispatchId = new Map(
    args.db
      .listFederatedDispatchesByIds(args.dispatchIds)
      .map((dispatch) => [dispatch.dispatch_id, dispatch])
  )
  for (const dispatchId of args.dispatchIds) {
    const dispatch = federatedByDispatchId.get(dispatchId)
    if (!dispatch) {
      continue
    }
    const groupKey = `${dispatch.environment_id}\u0000${dispatch.peer_fingerprint}`
    const group = groups.get(groupKey) ?? {
      environmentId: dispatch.environment_id,
      name: dispatch.environment_name,
      dispatches: []
    }
    group.dispatches.push(dispatch)
    groups.set(groupKey, group)
  }
  return [...groups.values()].flatMap((group) => {
    const batches: HostGroup[] = []
    for (let offset = 0; offset < group.dispatches.length; offset += ORCHESTRATION_FLEET_PAGE_MAX) {
      batches.push({
        ...group,
        dispatches: group.dispatches.slice(offset, offset + ORCHESTRATION_FLEET_PAGE_MAX)
      })
    }
    return batches
  })
}
