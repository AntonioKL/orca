import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { FederatedDispatchRow } from '../../orchestration/types'
import { projectOrchestrationFleet } from '../../../../shared/orchestration-fleet-projection'
import {
  applyFederatedFleetObservations,
  readFederatedFleetSnapshots
} from './orchestration-federated-fleet-snapshot'

describe('federated fleet snapshots', () => {
  it('batches a complete legacy fleet result to the host RPC maximum', async () => {
    const dispatchIds = Array.from(
      { length: 101 },
      (_, index) => `dispatch-${String(index).padStart(3, '0')}`
    )
    const dispatches = new Map(
      dispatchIds.map((dispatchId) => [
        dispatchId,
        federatedDispatch(dispatchId, 'peer-a', 'epoch-a')
      ])
    )
    const db = {
      getFederatedDispatch: (dispatchId: string) => dispatches.get(dispatchId),
      updateFederatedDispatchRuntimeEpoch: vi.fn(),
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    const fleetBatchSizes: number[] = []
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'environment-repointed',
        name: 'repointed',
        peerFingerprint: 'peer-a',
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(
        async (_environmentId: string, method: string, params: unknown) => {
          if (method === 'status.get') {
            return runtimeStatus('epoch-a')
          }
          const batch = (params as { dispatchIds: string[] }).dispatchIds
          fleetBatchSizes.push(batch.length)
          return {
            runtimeEpoch: 'epoch-a',
            items: batch.map((dispatchId) => ({
              dispatchId,
              observation: { status: 'live' as const, exactWorker: true }
            }))
          }
        }
      )
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({ runtime, db, dispatchIds })

    expect(fleetBatchSizes.toSorted((left, right) => right - left)).toEqual([100, 1])
    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(101)
  })

  it('partitions a repointed environment by pinned peer identity', async () => {
    const dispatches = new Map([
      ['dispatch-a', federatedDispatch('dispatch-a', 'peer-a', 'epoch-a')],
      ['dispatch-b', federatedDispatch('dispatch-b', 'peer-b', 'epoch-b')]
    ])
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const db = {
      getFederatedDispatch: (dispatchId: string) => dispatches.get(dispatchId),
      updateFederatedDispatchRuntimeEpoch,
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    const callOrchestrationWorkerServer = vi.fn(
      async (_environmentId: string, method: string, params: unknown) => {
        if (method === 'status.get') {
          return runtimeStatus('epoch-b')
        }
        expect(method).toBe('orchestration.federationFleetSnapshot')
        const dispatchIds = (params as { dispatchIds: string[] }).dispatchIds
        return {
          runtimeEpoch: 'epoch-b',
          items: dispatchIds.map((dispatchId) => ({
            dispatchId,
            observation: { status: 'live' as const, exactWorker: true }
          }))
        }
      }
    )
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'environment-repointed',
        name: 'repointed',
        peerFingerprint: 'peer-b',
        pairingRevision: 42
      }),
      callOrchestrationWorkerServer
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({
      runtime,
      db,
      dispatchIds: ['dispatch-a', 'dispatch-b']
    })

    expect(result.errors).toEqual([
      expect.objectContaining({
        environmentId: 'environment-repointed',
        code: 'host_unavailable',
        dispatchIds: ['dispatch-a']
      })
    ])
    expect(result.observations.get('dispatch-a')).toBeUndefined()
    expect(result.observations.get('dispatch-b')).toEqual({ status: 'live', exactWorker: true })
    for (const call of callOrchestrationWorkerServer.mock.calls) {
      expect((call as unknown[])[5]).toEqual({ expectedEnvironmentPairingRevision: 42 })
    }
    expect(callOrchestrationWorkerServer).toHaveBeenCalledWith(
      'environment-repointed',
      'orchestration.federationFleetSnapshot',
      { dispatchIds: ['dispatch-b'] },
      expect.any(Number),
      undefined,
      { expectedEnvironmentPairingRevision: 42 }
    )
    expect(updateFederatedDispatchRuntimeEpoch).toHaveBeenCalledWith('dispatch-b', 'epoch-b')
    expect(updateFederatedDispatchRuntimeEpoch).not.toHaveBeenCalledWith(
      'dispatch-a',
      expect.any(String)
    )
  })

  it('does not overwrite a confirmed release with later host unavailability', () => {
    const fleet = projectOrchestrationFleet({
      workers: [
        {
          dispatchId: 'dispatch-released',
          taskId: 'task-released',
          runId: 'run-home',
          parentTaskId: null,
          workerState: 'succeeded',
          dispatchStatus: 'completed',
          workerStage: 'released',
          agentTerminalHandle: null,
          paneKey: null,
          worktreeId: null,
          terminalState: 'released',
          resource: null
        }
      ],
      statuses: [],
      now: 1
    })

    applyFederatedFleetObservations(fleet, {
      observations: new Map(),
      errors: [
        {
          environmentId: 'environment-offline',
          name: 'offline',
          code: 'host_unavailable',
          dispatchIds: ['dispatch-released']
        }
      ],
      hosts: new Map([['dispatch-released', 'environment-offline']])
    })

    expect(fleet.workers[0]).toMatchObject({
      host: { kind: 'remote', id: 'environment-offline' },
      liveness: { verdict: 'exited', source: 'execution_host' },
      evidence: { liveStatus: 'unavailable', lastObservedAt: null }
    })
  })

  it('drops a fleet epoch projection after its home fence is superseded', async () => {
    const dispatch = federatedDispatch('dispatch-stale', 'peer-a', 'epoch-new')
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const projectFederatedDispatchObservation = vi.fn().mockReturnValue(false)
    const db = {
      getFederatedDispatch: () => dispatch,
      updateFederatedDispatchRuntimeEpoch,
      captureFederatedDispatchObservationFence: () => ({ dispatch_id: dispatch.dispatch_id }),
      projectFederatedDispatchObservation
    } as unknown as OrchestrationDb
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: dispatch.environment_id,
        name: dispatch.environment_name,
        peerFingerprint: dispatch.peer_fingerprint,
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(async (_environmentId, method: string) =>
        method === 'status.get'
          ? runtimeStatus('epoch-stale')
          : {
              runtimeEpoch: 'epoch-stale',
              items: [
                {
                  dispatchId: dispatch.dispatch_id,
                  observation: { status: 'live' as const, exactWorker: true }
                }
              ]
            }
      )
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({
      runtime,
      db,
      dispatchIds: [dispatch.dispatch_id]
    })

    expect(result.observations.has(dispatch.dispatch_id)).toBe(false)
    expect(projectFederatedDispatchObservation).toHaveBeenCalledOnce()
    expect(updateFederatedDispatchRuntimeEpoch).not.toHaveBeenCalled()
  })
})

function federatedDispatch(
  dispatchId: string,
  peerFingerprint: string,
  remoteRuntimeEpoch: string
): FederatedDispatchRow {
  return {
    dispatch_id: dispatchId,
    environment_id: 'environment-repointed',
    environment_name: 'repointed',
    peer_fingerprint: peerFingerprint,
    remote_runtime_epoch: remoteRuntimeEpoch,
    protocol_version: 3,
    remote_worktree_id: null,
    remote_terminal_handle: null,
    to_home_imported_sequence: 0,
    to_home_acknowledged_sequence: 0,
    created_at: '2026-08-27 00:00:00',
    updated_at: '2026-08-27 00:00:00'
  }
}

function runtimeStatus(runtimeId: string) {
  return {
    runtimeId,
    capabilities: [ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY],
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

function observationFenceMethods() {
  return {
    captureFederatedDispatchObservationFence: (dispatchId: string) => ({
      dispatch_id: dispatchId
    }),
    projectFederatedDispatchObservation: (_fence: unknown, projection: () => void) => {
      projection()
      return true
    }
  }
}
