import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker
} from './orchestration-fleet-projection'

function worker(id: string, overrides: Partial<FleetDurableWorker> = {}): FleetDurableWorker {
  return {
    dispatchId: id,
    taskId: `task-${id}`,
    runId: 'run-1',
    parentTaskId: null,
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    workerStage: 'prompt_delivered',
    agentTerminalHandle: `term-${id}`,
    paneKey: `tab-${id}:leaf-${id}`,
    worktreeId: `workspace-${id}`,
    terminalState: 'active',
    resource: null,
    ...overrides
  }
}

function status(
  id: string,
  receivedAt: number,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey: `tab-${id}:leaf-${id}`,
    terminalHandle: `term-${id}`,
    worktreeId: `workspace-${id}`,
    connectionId: null,
    state: 'working',
    prompt: 'secret transcript body',
    agentType: 'codex',
    model: 'gpt-test',
    receivedAt,
    stateStartedAt: receivedAt,
    ...overrides
  }
}

describe('orchestration fleet projection', () => {
  it('composes durable identity with redacted push-fed status', () => {
    const now = 10_000
    const result = projectOrchestrationFleet({
      workers: [
        worker('1', {
          parentTaskId: 'task-parent',
          resource: {
            id: 'resource-1',
            ownerDispatchId: '1',
            worktreeId: 'folder-workspace',
            paneKey: 'tab-1:leaf-1',
            hostScope: '{"kind":"local","hostId":"local"}',
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [status('1', now - 1)],
      now
    })

    expect(result.workers[0]).toMatchObject({
      id: '1',
      role: 'worker',
      parent: { taskId: 'task-parent' },
      provider: { id: 'codex', model: 'gpt-test' },
      host: { kind: 'local', id: 'local' },
      workspace: { id: 'workspace-1', kind: 'folder_or_worktree' },
      stage: { activity: 'working' },
      liveness: { verdict: 'live' },
      resource: { state: 'owned', id: 'resource-1' }
    })
    expect(JSON.stringify(result)).not.toContain('secret transcript body')
  })

  it('keeps local folder and unsupervised rows instead of assuming git resources', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('folder', {
          workerState: 'unsupervised',
          worktreeId: 'folder:/project',
          terminalState: 'retained'
        })
      ],
      statuses: [],
      now: 1
    })

    expect(result.workers[0]).toMatchObject({
      workspace: { id: 'folder:/project', kind: 'folder_or_worktree' },
      host: { kind: 'local' },
      liveness: { verdict: 'unverifiable', reason: 'missing_status' },
      resource: { state: 'absent', reason: 'unsupervised' },
      nextAction: { kind: 'inspect' }
    })
  })

  it('treats null host scope on local folder authority as local', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('local-null-scope', {
          resource: {
            id: 'resource-local-null-scope',
            ownerDispatchId: 'local-null-scope',
            worktreeId: 'folder:/project',
            paneKey: 'tab-local-null-scope:leaf-local-null-scope',
            hostScope: null,
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [status('local-null-scope', 100)],
      now: 100
    })

    expect(result.workers[0]).toMatchObject({
      host: { kind: 'local', id: 'local' },
      liveness: { verdict: 'live' }
    })
  })

  it('does not promote stale or restored status to live evidence', () => {
    const now = 2_000_000
    const stale = projectOrchestrationFleet({
      workers: [worker('stale')],
      statuses: [status('stale', 1)],
      now
    }).workers[0]
    const restored = projectOrchestrationFleet({
      workers: [worker('restored')],
      statuses: [status('restored', now, { restoredUnconfirmed: true })],
      now
    }).workers[0]

    expect(stale.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'stale_status',
      observedAt: 1
    })
    expect(stale.provider).toEqual({ id: 'codex', model: 'gpt-test' })
    expect(restored.liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'restored_unconfirmed'
    })
    expect(restored.evidence.liveStatus).toBe('redacted_restore')
  })

  it('does not treat a remote clock far ahead of the projection clock as live', () => {
    const result = projectOrchestrationFleet({
      workers: [worker('future')],
      statuses: [status('future', 10_000)],
      now: 1_000
    }).workers[0]

    expect(result?.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'future_status',
      observedAt: 10_000
    })
  })

  it('bounds 100-worker memory and paginates by stable Dispatch id', () => {
    const workers = Array.from({ length: 250 }, (_, index) => worker(`dispatch-${index}`))
    const first = projectOrchestrationFleet({ workers, statuses: [], limit: 10, now: 1 })
    const second = projectOrchestrationFleet({
      workers,
      statuses: [],
      cursor: first.page.nextCursor ?? undefined,
      limit: 500,
      now: 1
    })

    expect(first.workers).toHaveLength(10)
    expect(first.page).toMatchObject({
      total: 250,
      hasMore: true,
      nextCursor: 'dispatch-9'
    })
    expect(second.workers).toHaveLength(ORCHESTRATION_FLEET_PAGE_MAX)
    expect(second.workers[0]?.id).toBe('dispatch-10')
    expect(second.workers.at(-1)?.id).toBe('dispatch-109')
  })

  it('suggests release only for reclaimable ownership', () => {
    const result = projectOrchestrationFleet({
      workers: [worker('done', { terminalState: 'reclaimable' })],
      statuses: [],
      now: 1
    })

    expect(result.workers[0]?.nextAction).toEqual({
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', 'done']
    })
  })

  it('does not join a status carrying another Dispatch onto a reused pane', () => {
    const result = projectOrchestrationFleet({
      workers: [worker('old', { paneKey: 'reused:pane', agentTerminalHandle: 'term-reused' })],
      statuses: [
        status('reused', 100, {
          paneKey: 'reused:pane',
          terminalHandle: 'term-reused',
          orchestration: { taskId: 'task-new', dispatchId: 'new' }
        })
      ],
      now: 100
    })

    expect(result.workers[0]?.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'missing_status'
    })
    expect(result.workers[0]?.provider).toBeNull()
  })

  it('accepts a reminted pane only with exact Dispatch and process endpoint identity', () => {
    const durable = worker('dispatch-1', {
      paneKey: 'old-tab:old-leaf',
      agentTerminalHandle: 'term-worker',
      resource: {
        id: 'resource-1',
        ownerDispatchId: 'dispatch-1',
        worktreeId: null,
        paneKey: 'old-tab:old-leaf',
        processIncarnation: 'pty:inc-2',
        endpointId: 'runtime-1',
        endpointIncarnation: 'endpoint:inc-2',
        hostScope: '{"kind":"local","hostId":"local"}',
        ownershipState: 'owned',
        releaseState: 'not_requested',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    })
    const result = projectOrchestrationFleet({
      workers: [durable],
      statuses: [
        status('new', 100, {
          paneKey: 'new-tab:new-leaf',
          terminalHandle: 'term-worker',
          processIncarnation: 'pty:inc-2',
          endpointId: 'runtime-1',
          endpointIncarnation: 'endpoint:inc-2',
          orchestration: { taskId: 'task-dispatch-1', dispatchId: 'dispatch-1' }
        })
      ],
      now: 100
    })

    expect(result.workers[0]?.liveness.verdict).toBe('live')
  })

  it('keeps provider-session-only status as identity without liveness evidence', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('session-only', {
          resource: {
            id: 'resource-session',
            ownerDispatchId: 'session-only',
            worktreeId: null,
            paneKey: 'tab-session:leaf-session',
            processIncarnation: 'pty:inc-1',
            endpointId: 'runtime-1',
            endpointIncarnation: 'endpoint:inc-1',
            hostScope: '{"kind":"local","hostId":"local"}',
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [
        status('session-only', 100, {
          providerSessionOnly: true,
          orchestration: { taskId: 'task-session-only', dispatchId: 'session-only' },
          providerSession: { key: 'session_id', id: 'session-1' }
        })
      ],
      now: 100
    })

    expect(result.workers[0]?.provider).toEqual({ id: 'codex', model: 'gpt-test' })
    expect(result.workers[0]?.liveness).toMatchObject({ verdict: 'unverifiable' })
  })

  it('treats unknown or federated host scope as remote and unverifiable without endpoint proof', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('federated', {
          resource: {
            id: 'resource-federated',
            ownerDispatchId: 'federated',
            worktreeId: null,
            paneKey: 'tab-federated:leaf-federated',
            hostScope: '{"kind":"federated","targetId":"host-unknown"}',
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [status('federated', 100)],
      now: 100
    })

    expect(result.workers[0]?.host).toEqual({ kind: 'remote', id: 'host-unknown' })
    expect(result.workers[0]?.liveness.verdict).toBe('unverifiable')
  })
})
