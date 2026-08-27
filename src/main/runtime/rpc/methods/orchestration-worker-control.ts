import { z } from 'zod'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../shared/orchestration-worker-output'
import { contextOnlyAbandonWarning } from '../../orchestration/context-only-dispatch-release'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import {
  callFederatedWorkerShow,
  exposeFederatedWorkerObservation,
  exposeWorker,
  inspectWorkerTerminal,
  resolvePinnedFederatedServer,
  showContextOnlyWorker
} from './orchestration-worker-observation'
import { readArchivedWorkerOutput } from './orchestration-worker-archive-read'
import { readExactWorkerOutput } from './orchestration-worker-output'
import { exposeWorkerTerminalResource } from './orchestration-worker-release-completion'
import { readFederatedWorkerOutput } from './orchestration-federated-worker-read'
const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })
const WorkerReadParams = WorkerDispatchParams.extend({
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
})

export const ORCHESTRATION_WORKER_CONTROL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerShow',
    params: WorkerDispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      let worker = db.getWorkerDispatch(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} was not found.`
        )
      }
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!worker) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Federated Worker Dispatch ${params.dispatch} has no worker record.`
          )
        }
        const observationFence = db.captureFederatedDispatchObservationFence(params.dispatch)
        if (!observationFence) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Federated Worker Dispatch ${params.dispatch} has no observation projection.`
          )
        }
        const server = resolvePinnedFederatedServer(runtime, federated)
        runtime.ensureOrchestrationFederationRelay(dispatch.run_id)
        const remote = await callFederatedWorkerShow(runtime, federated)
        const attachment = remote.attachment
        const settlementQueued =
          attachment.state === 'succeeded' ||
          (attachment.state === 'failed' && attachment.stage === 'worker_report_queued')
        const observationProjected = db.projectFederatedDispatchObservation(
          observationFence,
          () => {
            let projectedWorker = db.updateWorkerSetupEvidence({
              dispatchId: params.dispatch,
              setupState: attachment.setup_state,
              effects: attachment.effects
            }).worker
            if (
              attachment.state === 'stopped' &&
              ['stopping', 'stop_unknown'].includes(projectedWorker.state)
            ) {
              projectedWorker = db.reconcileFederatedWorkerStop(params.dispatch)
            } else if (
              !settlementQueued &&
              ['ready', 'failed', 'stopped', 'start_unknown'].includes(attachment.state)
            ) {
              projectedWorker = db.reconcileFederatedWorkerStart({
                dispatchId: params.dispatch,
                state: attachment.state as 'ready' | 'failed' | 'stopped' | 'start_unknown',
                stage: attachment.stage,
                lastError: attachment.last_error,
                worktreeId: attachment.worktree_id,
                terminalHandle: attachment.terminal_handle,
                setupState: attachment.setup_state,
                effects: attachment.effects,
                residualResources: attachment.residualResources
              })
            }
            if (
              attachment.state === 'ready' &&
              attachment.worktree_id &&
              attachment.terminal_handle
            ) {
              db.updateFederatedDispatchResources({
                dispatchId: params.dispatch,
                remoteRuntimeEpoch: remote.runtimeEpoch,
                worktreeId: attachment.worktree_id,
                terminalHandle: attachment.terminal_handle
              })
            } else {
              db.updateFederatedDispatchRuntimeEpoch(params.dispatch, remote.runtimeEpoch)
            }
            worker = projectedWorker
          }
        )
        if (settlementQueued) {
          await runtime
            .syncOrchestrationFederatedDispatchAfterCurrent(params.dispatch)
            .catch(() => undefined)
        }
        worker = db.getWorkerDispatch(params.dispatch)
        if (!worker) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Worker Dispatch ${params.dispatch} was not found after remote reconciliation.`
          )
        }
        return {
          dispatch: db.getDispatchContextById(params.dispatch),
          worker: exposeWorker(worker),
          server: { environmentId: server.environmentId, name: server.name },
          remoteRuntimeEpoch:
            db.getFederatedDispatch(params.dispatch)?.remote_runtime_epoch ??
            (observationProjected ? remote.runtimeEpoch : null),
          terminal: observationProjected ? remote.terminal : null,
          observation: exposeFederatedWorkerObservation(remote.observation, observationProjected)
        }
      }
      if (!worker) {
        return showContextOnlyWorker(runtime, db, dispatch)
      }
      if (worker.runtime_epoch && worker.runtime_epoch !== runtime.getRuntimeId()) {
        if (worker.state === 'starting') {
          worker = db.markWorkerStartUnknown(
            params.dispatch,
            worker.stage,
            'The runtime restarted before worker-start reached a terminal receipt.'
          )
        } else if (worker.state === 'stopping') {
          worker = db.markWorkerStopUnknown(
            params.dispatch,
            'The runtime restarted before worker-stop reached a terminal receipt.'
          )
        }
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      return {
        dispatch,
        worker: exposeWorker(worker),
        terminal: observation.exact ? observation.terminal : null,
        observation: {
          status: observation.status,
          exactWorker: observation.exact,
          // Why: a bare `unverifiable` is not actionable without naming what we lost.
          ...(observation.reason ? { reason: observation.reason } : {}),
          // Why conditional: a present null must mean "looked, nothing waiting". An
          // unattached, missing or identity-changed worker was never looked at, and saying
          // null there is the false negative this field exists to remove.
          ...(observation.agentWait !== undefined ? { agentWait: observation.agentWait } : {})
        },
        terminalResource: resource ? exposeWorkerTerminalResource(resource) : null
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerRead',
    params: WorkerReadParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        const server = resolvePinnedFederatedServer(runtime, federated)
        return readFederatedWorkerOutput({
          runtime,
          db,
          server,
          federated,
          dispatchId: params.dispatch,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit
        })
      }
      const dispatch = db.getDispatchContextById(params.dispatch)
      const worker = db.getWorkerDispatch(params.dispatch)
      const terminalHandle = worker?.agent_terminal_handle ?? dispatch?.assignee_handle
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      if (!terminalHandle) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} has no agent terminal.`
        )
      }
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      if (resource && ['releasing', 'unknown', 'released'].includes(resource.release_state)) {
        // Archive capture is not close evidence; recheck the execution host while releasing.
        let liveness: 'live' | 'unverifiable' | 'exited' =
          resource.release_state === 'released' ? 'exited' : 'unverifiable'
        if (resource.release_state === 'releasing') {
          const observed = await inspectWorkerTerminal(runtime, db, params.dispatch)
          liveness =
            observed.status === 'live'
              ? 'live'
              : observed.status === 'exited'
                ? 'exited'
                : 'unverifiable'
        }
        return readArchivedWorkerOutput({
          db,
          dispatchId: params.dispatch,
          workerState: worker?.state ?? 'unsupervised',
          resource,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit,
          liveness
        })
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      if (!observation.exact) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Worker Dispatch ${params.dispatch} no longer resolves to its exact process.`
        )
      }
      const output = await readExactWorkerOutput({
        runtime,
        dispatchId: params.dispatch,
        terminalHandle,
        workerState: worker?.state ?? 'unsupervised',
        terminalStatus:
          observation.status === 'exited'
            ? 'exited'
            : observation.status === 'unverifiable'
              ? 'unknown'
              : 'running',
        terminalLiveness:
          observation.status === 'unverifiable'
            ? 'unverifiable'
            : observation.status === 'exited'
              ? 'exited'
              : 'live',
        attachedAt: worker?.created_at ?? dispatch.dispatched_at ?? dispatch.created_at,
        source: params.source,
        cursor: params.cursor,
        limit: params.limit
      })
      const afterRead = await inspectWorkerTerminal(runtime, db, params.dispatch)
      if (!afterRead.exact) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Worker Dispatch ${params.dispatch} changed process while output was read.`
        )
      }
      return output
    }
  }),
  defineMethod({
    name: 'orchestration.workerAbandon',
    params: WorkerDispatchParams,
    handler: (params, { runtime }) => {
      const abandoned = runtime.getOrchestrationDb().abandonWorkerDispatch(params.dispatch)
      if (abandoned.disposition === 'context_only') {
        if (!abandoned.alreadySettled) {
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        }
        return {
          dispatchId: params.dispatch,
          state: abandoned.state,
          alreadySettled: abandoned.alreadySettled,
          stale: !abandoned.releasedCurrentTask,
          processAction: 'none',
          warning: contextOnlyAbandonWarning(abandoned),
          residualResources: []
        }
      }
      const worker = abandoned.worker
      if (abandoned.disposition === 'abandoned') {
        runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
      }
      return {
        dispatchId: params.dispatch,
        state: worker.state,
        alreadySettled: abandoned.disposition !== 'abandoned',
        stale: abandoned.disposition === 'stale',
        processAction: 'none',
        warning:
          abandoned.disposition === 'stale'
            ? 'The Dispatch is no longer current; no state or process changed.'
            : 'Possibly-live resources were retained; no process was stopped or deleted.',
        residualResources: JSON.parse(worker.residual_resources) as unknown[]
      }
    }
  })
]
