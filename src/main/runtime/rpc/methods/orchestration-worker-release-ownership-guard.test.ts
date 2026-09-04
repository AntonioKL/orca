import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './orchestration-worker-release-test-harness'

describe('workerRelease on a retained resource whose process exited', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('does not release a terminal the user took over', async () => {
    const { dispatchId } = await harness.startSettledWorker('succeeded')
    const takeover = (await harness.call('orchestration.workerTerminalUserInput', {
      paneKey: harness.workerPaneKey
    })) as { changed: number }
    expect(takeover.changed).toBe(1)
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe(
      'user_owned'
    )

    // The agent process later exits on its own; the user's pane and scrollback remain.
    harness.inspectProcessLiveness.mockResolvedValue('exited')
    const receipt = (await harness.call('orchestration.workerRelease', {
      dispatch: dispatchId
    })) as { state: string; reason?: string; archive: unknown }

    expect(receipt.state).toBe('retained')
    expect(receipt.reason).toBe('user_takeover')
    const after = harness.db.getWorkerTerminalResourceByOwner(dispatchId)
    expect(after?.ownership_state).toBe('user_owned')
    expect(after?.release_state).not.toBe('released')
  })

  it.each(['transferred', 'external'] as const)(
    'does not release a %s resource on an exited process',
    async (ownershipState) => {
      const { dispatchId } = await harness.startSettledWorker('succeeded')
      const resource = harness.db.getWorkerTerminalResourceByOwner(dispatchId)!
      harness.db.db
        .prepare('UPDATE worker_terminal_resources SET ownership_state = ? WHERE id = ?')
        .run(ownershipState, resource.id)

      harness.inspectProcessLiveness.mockResolvedValue('exited')
      const receipt = (await harness.call('orchestration.workerRelease', {
        dispatch: dispatchId
      })) as { state: string }

      expect(receipt.state).toBe('retained')
      const after = harness.db.getWorkerTerminalResourceByOwner(dispatchId)
      expect(after?.ownership_state).toBe(ownershipState)
      expect(after?.release_state).not.toBe('released')
    }
  )

  it('does not mark released without a durable output archive', async () => {
    const { dispatchId } = await harness.startWorker()
    // Abandon so release reports `identity_unproven` and keeps the still-owned pane.
    expect(harness.db.abandonWorkerDispatch(dispatchId).disposition).toBe('abandoned')
    expect(harness.db.getWorkerTerminalArchive(dispatchId)).toBeFalsy()

    harness.inspectProcessLiveness.mockResolvedValue('exited')
    const receipt = (await harness.call('orchestration.workerRelease', {
      dispatch: dispatchId
    })) as { state: string }

    expect(receipt.state).toBe('retained')
    expect(harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe(
      'released'
    )
  })
})
