import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeWithGetOrchestrationDispatchAuthority } from '../../../../orca-runtime-get-orchestration-dispatch-authority'
import { toAgentStatusIpcPayload } from '../../../../../agent-hooks/server/server-status-identity'
import type { EnrichedAgentHookEventPayload } from '../../../../../agent-hooks/server/server-types'
import type { AgentStatusOrchestrationContext } from '../../../../../../shared/agent-status-types'
import { projectFleetWorkerPage } from './worker-observation'

const PANE_KEY = 'tab-fleet:leaf-fleet'
const TERMINAL_HANDLE = 'term_fleet'
const DISPATCH_ID = 'disp-fleet'
const PROCESS_INCARNATION = 'pty-fleet:inc-1'
/** `projectFleetWorkerPage` stamps `Date.now()` itself, so the fixture must ride the wall clock. */
const observedAt = (): number => Date.now() - 1_000

/** Exactly what `agentHookServer.getStatusSnapshot()` publishes: pane identity, no terminal identity. */
function hookRowAsPublished(): ReturnType<typeof toAgentStatusIpcPayload> {
  return toAgentStatusIpcPayload({
    paneKey: PANE_KEY,
    tabId: 'tab-fleet',
    worktreeId: 'wt-fleet',
    connectionId: null,
    receivedAt: observedAt(),
    stateStartedAt: observedAt(),
    payload: { state: 'working', agentType: 'claude' }
  } as unknown as EnrichedAgentHookEventPayload)
}

function createRuntime(args: {
  handleForPane?: string
  orchestration?: AgentStatusOrchestrationContext
  incarnationForHandle?: string | null
}): OrcaRuntimeService {
  const host = {
    getAgentStatusSnapshotFn: () => [hookRowAsPublished()],
    getAgentStatusTerminalHandleForPaneKey: (paneKey: string) =>
      paneKey === PANE_KEY ? args.handleForPane : undefined,
    getAgentStatusOrchestrationContextForPaneKey: (paneKey: string) =>
      paneKey === PANE_KEY ? args.orchestration : undefined,
    getTerminalProcessIncarnation: () =>
      args.incarnationForHandle === undefined ? PROCESS_INCARNATION : args.incarnationForHandle
  }
  return {
    // Drive the shipping accessor, not a copy of it: the identity loss was in this method.
    getOrchestrationFleetAgentStatusSnapshot: () =>
      OrcaRuntimeWithGetOrchestrationDispatchAuthority.prototype.getOrchestrationFleetAgentStatusSnapshot.call(
        host as never
      )
  } as unknown as OrcaRuntimeService
}

function createDb(): OrchestrationDb {
  return {
    listWorkerTerminalResources: () => [
      {
        dispatchId: DISPATCH_ID,
        taskId: 'task-fleet',
        runId: 'run-fleet',
        parentTaskId: 'task-parent',
        workerState: 'ready',
        dispatchStatus: 'dispatched',
        workerStage: 'input_accepted',
        agentTerminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        worktreeId: 'wt-fleet',
        terminalState: 'active',
        pendingInput: false,
        pendingApproval: false,
        terminationReason: null,
        resource: {
          id: 'res-fleet',
          owner_dispatch_id: DISPATCH_ID,
          worktree_id: 'wt-fleet',
          pane_key: PANE_KEY,
          process_incarnation: PROCESS_INCARNATION,
          endpoint_id: null,
          endpoint_incarnation: null,
          host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
          ownership_state: 'owned',
          release_state: 'none',
          updated_at: new Date().toISOString()
        },
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        databaseId: 1
      }
    ],
    getWorkerAttentionFactsForDispatches: () => new Map()
  } as unknown as OrchestrationDb
}

describe('local fleet liveness from a hook row that carries only a pane key', () => {
  it('publishes hook rows without terminal identity', () => {
    // Guards the premise: the fix must add identity, not assume the hook server already does.
    expect(hookRowAsPublished().terminalHandle).toBeUndefined()
    expect(hookRowAsPublished().orchestration).toBeUndefined()
  })

  it('reads live for a running local worker whose pane still owns its handle', () => {
    const page = projectFleetWorkerPage(
      createRuntime({ handleForPane: TERMINAL_HANDLE }),
      createDb(),
      DISPATCH_ID
    )

    expect(page?.workers[0]).toMatchObject({
      liveness: { verdict: 'live', source: 'agent_status' },
      evidence: { liveStatus: 'fresh' },
      stage: { activity: 'working' },
      nextAction: { kind: 'none' },
      attention: { requiresAction: false }
    })
  })

  it('carries the dispatch context the renderer boundary attaches', () => {
    const page = projectFleetWorkerPage(
      createRuntime({
        handleForPane: TERMINAL_HANDLE,
        orchestration: { dispatchId: DISPATCH_ID } as AgentStatusOrchestrationContext
      }),
      createDb(),
      DISPATCH_ID
    )

    expect(page?.workers[0]?.liveness.verdict).toBe('live')
  })

  it('refuses a pane whose handle now belongs to another terminal', () => {
    const page = projectFleetWorkerPage(
      createRuntime({ handleForPane: 'term_reused' }),
      createDb(),
      DISPATCH_ID
    )

    expect(page?.workers[0]).toMatchObject({
      liveness: { verdict: 'unverifiable', reason: 'missing_status' },
      evidence: { liveStatus: 'unavailable' }
    })
  })

  it('refuses a pane whose handle now belongs to another dispatch', () => {
    const page = projectFleetWorkerPage(
      createRuntime({
        handleForPane: TERMINAL_HANDLE,
        orchestration: { dispatchId: 'disp-other' } as AgentStatusOrchestrationContext
      }),
      createDb(),
      DISPATCH_ID
    )

    expect(page?.workers[0]?.liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'missing_status'
    })
  })

  it('refuses a pane that no longer resolves to a terminal', () => {
    const page = projectFleetWorkerPage(createRuntime({}), createDb(), DISPATCH_ID)

    expect(page?.workers[0]?.liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'missing_status'
    })
  })
})
