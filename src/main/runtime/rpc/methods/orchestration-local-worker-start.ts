import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { RunRow, TaskRow } from '../../orchestration/types'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

type WorkerStartMutation = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

export async function startLocalWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorPane: string | null
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
}): Promise<unknown> {
  const { params, runtime, db, run, coordinatorPane, existingTask, orchestrationMutation } = args
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })

  const coordinatorTerminal = await runtime.showTerminal(params.from)
  const creationWorktree = createsWorktree
    ? await runtime.showManagedWorktree(`id:${coordinatorTerminal.worktreeId}`)
    : undefined
  if (creationWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? creationWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  let resolvedWorktree = creationWorktree
    ? undefined
    : requestedWorktree === 'current'
      ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorTerminal.worktreeId}`)
      : await runtime.showManagedTerminalWorkspace(requestedWorktree)
  if (params.terminal) {
    const explicitTerminal = await runtime.showTerminal(params.terminal)
    if (explicitTerminal.worktreeId !== resolvedWorktree?.id) {
      throw new OrchestrationError(
        'terminal_worktree_mismatch',
        `Terminal ${params.terminal} does not belong to worktree ${resolvedWorktree?.id}.`
      )
    }
    if (!(await runtime.isTerminalRunningAgent(params.terminal))) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Terminal ${params.terminal} is not running a recognized agent.`
      )
    }
  }

  const startOptions = {
    worktree: requestedWorktree,
    resolvedWorktreeId: resolvedWorktree?.id ?? null,
    name: params.name ?? null,
    repo: params.repo ?? creationWorktree?.repoId ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    launch: launch.receipt,
    timeoutMs: params.timeoutMs ?? 60_000,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: existingTask?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: parseTaskDeps(params.deps),
    taskParentId: params.parent,
    taskRunId: run.id,
    taskCreatedByTerminalHandle: params.from,
    taskCreatedByPaneKey: coordinatorPane ?? undefined,
    taskCreatedByProcessIncarnation:
      runtime.getTerminalProcessIncarnation(params.from) ?? undefined,
    taskCreatedByRunGeneration: run.consumer_generation,
    retryOf: params.retryOf,
    startOptions,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation
  })
  const effects: WorkerEffect[] = []
  const task = started.task
  if (resolvedWorktree) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  let terminalHandle = params.terminal
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  let setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }
  try {
    if (creationWorktree) {
      failedStage = 'worktree_create'
      const created = await createWorkerWorktree({
        runtime,
        db,
        dispatchId: started.dispatch.id,
        requestedWorktree,
        coordinatorWorktree: creationWorktree,
        params,
        agent: agent as TuiAgent,
        launchPreferences: launch.preferences,
        effects
      })
      resolvedWorktree = created.worktree
      terminalHandle = created.terminalHandle
      setupReceipt = created.setupReceipt
    } else if (!terminalHandle) {
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'terminal_creating',
        worktreeId: resolvedWorktree!.id,
        effects
      })
      const terminal = await createExistingWorktreeWorkerTerminal({
        runtime,
        worktreeId: resolvedWorktree!.id,
        agent: agent as TuiAgent,
        launchPreferences: launch.preferences,
        taskId: task.id,
        effects
      })
      terminalHandle = terminal.handle
      terminalRevealWarning = terminal.warning
    } else {
      effects.push({ kind: 'terminal', role: 'agent', action: 'reused', id: terminalHandle })
    }
    if (!resolvedWorktree || !terminalHandle) {
      throw new Error('Worker topology did not resolve an agent terminal and worktree.')
    }
    const setupStage = {
      db,
      dispatchId: started.dispatch.id,
      worktreeId: resolvedWorktree.id,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    failedStage = 'agent_readiness'
    const wait = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: params.timeoutMs ?? 60_000
    })
    persistWorkerSetupWaitOutcome({ ...setupStage, wait })
    if (!wait.satisfied) {
      if (setupReceipt.state === 'failed') {
        failedStage = 'setup_wait'
      }
      throw new Error(
        wait.blockedReason
          ? `Agent startup blocked: ${wait.blockedReason}`
          : `Agent did not become ready (${wait.status}).`
      )
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: resolvedWorktree.id,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership: params.terminal ? 'external' : 'created'
    })

    failedStage = 'dispatch_input'
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: started.dispatch.id,
      taskSpec: task.spec,
      coordinatorHandle: params.from,
      workerHandle: terminalHandle,
      dispatchCapability: capability,
      devMode: params.devMode,
      cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
    })
    const prompt = await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: orchestrationMutation?.requestId ?? started.dispatch.id
    })
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'accepted'
    })
    const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
    monitorWorkerSetup({
      runtime,
      db,
      runId: run.id,
      dispatchId: started.dispatch.id,
      setupReceipt,
      effects
    })
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      setup: setupReceipt,
      launch: launch.receipt,
      timeoutMs: params.timeoutMs ?? 60_000,
      effects,
      ...(prompt.prompt ? { prompt: prompt.prompt } : {}),
      residualResources: [],
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
  } catch (error) {
    return failWorkerStartWithReceipt({
      db,
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launch.receipt
    })
  }
}

function parseTaskDeps(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('not an array of strings')
    }
    return parsed
  } catch {
    throw new OrchestrationError(
      'invalid_argument',
      'Invalid --deps: must be a JSON array of task IDs'
    )
  }
}
