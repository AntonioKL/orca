import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  refreshOrchestrationFleetLivenessAttention,
  type OrchestrationFleetPage
} from '../../../../shared/orchestration-fleet-projection'
import { getOrchestrationPeerCapabilityCache } from '../../orchestration/orchestration-peer-capability-cache'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { FederatedDispatchRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { resolvePinnedFederatedServer } from './orchestration-worker-observation'

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
  code: 'capability_unsupported' | 'host_unavailable'
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
    const observationFences = new Map(
      group.dispatches.flatMap((dispatch) => {
        const fence = args.db.captureFederatedDispatchObservationFence(dispatch.dispatch_id)
        return fence ? [[dispatch.dispatch_id, fence] as const] : []
      })
    )
    const error = (code: FederatedFleetHostError['code']): FederatedFleetHostError => ({
      environmentId: group.environmentId,
      name: group.name,
      code,
      dispatchIds
    })
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { observations: [], error: error('host_unavailable') }
    }
    const timeoutMs = Math.min(FLEET_HOST_TIMEOUT_MS, remaining)
    const first = group.dispatches[0]
    const cache = getOrchestrationPeerCapabilityCache(args.runtime)
    let observedCapabilityEpoch: string | null = null
    try {
      const server = resolvePinnedFederatedServer(args.runtime, first)
      const capability = await cache.resolve({
        peerFingerprint: first.peer_fingerprint,
        expectedRuntimeEpoch: first.remote_runtime_epoch,
        capability: ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
        probe: () =>
          args.runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'status.get',
            undefined,
            timeoutMs,
            undefined,
            { expectedEnvironmentPairingRevision: server.pairingRevision }
          ) as Promise<RuntimeStatus>
      })
      observedCapabilityEpoch = capability.runtimeEpoch
      if (!capability.supported) {
        if (observedCapabilityEpoch) {
          projectFleetRuntimeEpochs(args.db, observationFences, observedCapabilityEpoch)
        }
        return { observations: [], error: error('capability_unsupported') }
      }
      const snapshot = (await args.runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationFleetSnapshot',
        { dispatchIds },
        Math.min(timeoutMs, Math.max(1, deadline - Date.now())),
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
        observations: snapshot.items.filter(
          (item) => expected.has(item.dispatchId) && projectedDispatches.has(item.dispatchId)
        ),
        error: null
      }
    } catch (caught) {
      if (caught instanceof OrchestrationError && caught.code === 'method_not_found') {
        cache.remember(
          first.peer_fingerprint,
          first.remote_runtime_epoch ?? 'unknown',
          ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
          false
        )
        if (observedCapabilityEpoch) {
          projectFleetRuntimeEpochs(args.db, observationFences, observedCapabilityEpoch)
        }
        return { observations: [], error: error('capability_unsupported') }
      }
      return { observations: [], error: error('host_unavailable') }
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
  observedAt = Date.now()
): void {
  const unavailableDispatches = new Set(federated.errors.flatMap((error) => error.dispatchIds))
  for (const worker of fleet.workers) {
    const hostId = federated.hosts.get(worker.dispatchId)
    if (hostId) {
      worker.host = { kind: 'remote', id: hostId }
    }
    const observation = federated.observations.get(worker.dispatchId)
    if (!observation) {
      if (unavailableDispatches.has(worker.dispatchId)) {
        if (worker.liveness.verdict === 'exited') {
          continue
        }
        worker.liveness = { verdict: 'unverifiable', reason: 'host_unavailable' }
        worker.evidence.liveStatus = 'unavailable'
        worker.evidence.lastObservedAt = null
        refreshOrchestrationFleetLivenessAttention(worker)
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
          : { verdict: 'unverifiable', reason: 'host_unavailable' }
    worker.evidence.liveStatus = observation.status === 'live' ? 'fresh' : 'unavailable'
    worker.evidence.lastObservedAt = observation.status === 'live' ? observedAt : null
    refreshOrchestrationFleetLivenessAttention(worker)
  }
}

function groupFederatedDispatches(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchIds: readonly string[]
}): HostGroup[] {
  const groups = new Map<string, HostGroup>()
  for (const dispatchId of args.dispatchIds) {
    const dispatch = args.db.getFederatedDispatch(dispatchId)
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
