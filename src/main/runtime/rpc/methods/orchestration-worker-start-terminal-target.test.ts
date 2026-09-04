import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './orchestration-worker-release-test-harness'

describe('worker-start --terminal target', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('refuses the coordinator terminal by handle', async () => {
    const task = harness.db.createTask({ spec: 'self adoption', runId: harness.activeRunId })

    await expect(
      harness.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        terminal: 'term_coord'
      })
    ).rejects.toMatchObject({
      code: 'terminal_is_coordinator',
      message: expect.stringContaining("coordinator's own terminal")
    })
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('refuses a different handle that resolves to the coordinator pane', async () => {
    const task = harness.db.createTask({ spec: 'self adoption alias', runId: harness.activeRunId })
    vi.spyOn(harness.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' || handle === 'term_coord_alias' ? harness.coordinatorPaneKey : null
    )

    await expect(
      harness.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        terminal: 'term_coord_alias'
      })
    ).rejects.toMatchObject({ code: 'terminal_is_coordinator' })
  })

  it('still accepts a separate agent terminal in the same worktree', async () => {
    const started = await harness.startWorker({ terminal: 'term_worker' })
    expect(started.dispatchId).toEqual(expect.any(String))
  })
})
