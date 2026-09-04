import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_CLOSE_EXIT_CAUSE } from '../../../../../../shared/terminal-exit-cause'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const h = createOrchestrationWorkerReleaseHarness()
beforeEach(() => h.setup())
afterEach(() => h.cleanup())

type StopReceipt = { state: string; alreadySettled: boolean; processAction: string }

function fireExit(handle: string): void {
  ;(
    h.runtime as unknown as {
      failActiveDispatchOnExit: (
        handle: string,
        paneKey: string | null,
        exitCode: number,
        cause: typeof OPERATOR_CLOSE_EXIT_CAUSE
      ) => void
    }
  ).failActiveDispatchOnExit(handle, h.workerPaneKey, 0, OPERATOR_CLOSE_EXIT_CAUSE)
}

describe('a worker whose process exits while its own stop is in flight', () => {
  it('reports the stop that succeeded, not a failed dispatch', async () => {
    const { dispatchId } = await h.startWorker()
    // The PTY exit lands between beginWorkerStop and settleWorkerStop.
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      fireExit(handle)
      return { handle, tabId: 'tab-worker', ptyKilled: true } as never
    })

    const receipt = (await h.call('orchestration.workerStop', {
      dispatch: dispatchId
    })) as StopReceipt
    expect(receipt).toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')

    const second = (await h.call('orchestration.workerStop', {
      dispatch: dispatchId
    })) as StopReceipt
    expect(second).toMatchObject({ state: 'stopped', alreadySettled: true })
  })

  it('still reports the stop when the exit races a close that then throws', async () => {
    const { dispatchId } = await h.startWorker()
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      fireExit(handle)
      throw new Error('Terminal handle is stale')
    })

    const receipt = (await h.call('orchestration.workerStop', {
      dispatch: dispatchId
    })) as StopReceipt
    expect(receipt.state).toBe('stopped')
  })

  it('leaves an exit with no stop in flight failing the dispatch', async () => {
    const { dispatchId } = await h.startWorker()
    fireExit('term_worker')
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })
})
