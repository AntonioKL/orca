import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  assertCallerHandleMatchesEvidence,
  resolveOrchestrationCaller
} from './orchestration-run-scope'
import type { RunRow } from '../../orchestration/types'
import { isCurrentRunCoordinator } from '../../orchestration/run-coordinator-authority'
import {
  isCallerCurrentRunCoordinator,
  resolveRunCoordinatorIdentity
} from './orchestration-coordinator-caller'

async function observeRunCoordinator(
  runtime: Parameters<typeof resolveOrchestrationCaller>[0],
  run: RunRow
) {
  let status: 'live' | 'unverifiable' | 'exited' = 'unverifiable'
  if (run.coordinator_process_incarnation && run.coordinator_host_scope) {
    status = await runtime.inspectTerminalProcessIncarnationLiveness(
      run.coordinator_process_incarnation,
      run.coordinator_host_scope
    )
  } else if (run.coordinator_handle) {
    const verdict = runtime.getTerminalLivenessVerdict(run.coordinator_handle)
    if (runtime.getLiveTerminalPaneKey(run.coordinator_handle) || verdict?.status === 'live') {
      status = 'live'
    } else if (verdict?.status === 'unverifiable') {
      status = 'unverifiable'
    } else if (verdict?.status === 'exited') {
      status = 'exited'
    }
  }
  return {
    coordinatorHandle: run.coordinator_handle,
    coordinatorPaneKey: run.coordinator_pane_key,
    coordinatorProcessIncarnation: run.coordinator_process_incarnation,
    coordinatorHostScope: run.coordinator_host_scope,
    status
  }
}

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal')
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const identity = resolveRunCoordinatorIdentity(runtime, params.from, paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        coordinatorProcessIncarnation: identity.processIncarnation,
        coordinatorHostScope: identity.hostScope
      })
      runtime.cancelMessageWaiters(params.from)
      if (priorRun) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
    params: RunUseParams,
    handler: async (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority
      }
    ) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireStablePane: true,
        evidenceAssertedByCaller: true
      })
      if (
        params.takeoverLegacy &&
        (callerAuthority?.terminalHandle !== params.from || callerAuthority.paneKey !== paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const db = runtime.getOrchestrationDb()
      const targetRun = db.getRun(params.id)
      const identity = resolveRunCoordinatorIdentity(runtime, params.from, paneKey)
      const incumbentIdentity =
        targetRun &&
        !targetRun.coordinator_process_incarnation &&
        targetRun.coordinator_handle &&
        targetRun.coordinator_handle !== params.from
          ? resolveRunCoordinatorIdentity(
              runtime,
              targetRun.coordinator_handle,
              targetRun.coordinator_pane_key
            )
          : null
      const dynamicProcessContinuity = Boolean(
        incumbentIdentity?.processIncarnation &&
        identity.processIncarnation &&
        incumbentIdentity.processIncarnation === identity.processIncarnation &&
        incumbentIdentity.hostScope === identity.hostScope
      )
      const sameAuthority = targetRun
        ? isCurrentRunCoordinator(targetRun, identity) || dynamicProcessContinuity
        : false
      const incumbentObservation =
        targetRun && !sameAuthority ? await observeRunCoordinator(runtime, targetRun) : undefined
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        coordinatorProcessIncarnation: identity.processIncarnation,
        coordinatorHostScope: identity.hostScope,
        authorityContinuity: dynamicProcessContinuity,
        incumbentObservation,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const run = runtime.getOrchestrationDb().getCurrentRunForPane(paneKey)
      return {
        run: run && isCallerCurrentRunCoordinator(runtime, run, params.from, paneKey) ? run : null
      }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => runtime.getOrchestrationDb().listRuns(params)
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      const callerPaneKey = params.from ? runtime.getLiveTerminalPaneKey(params.from) : null
      return {
        run,
        binding: {
          currentConsumer: Boolean(
            params.from &&
            run.legacy === 0 &&
            callerPaneKey !== null &&
            db.getCurrentRunForPane(callerPaneKey)?.id === run.id &&
            isCallerCurrentRunCoordinator(runtime, run, params.from, callerPaneKey)
          )
        }
      }
    }
  })
]
