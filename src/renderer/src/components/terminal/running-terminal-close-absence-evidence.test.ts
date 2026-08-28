import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
// Why the real producer and not a hand-written literal: the point of these cases is that
// the host and the guard agree on one shape, and a literal would keep agreeing after a drift.
import {
  buildAbsentPtyInspection,
  buildPtyProcessInspectionWireResult
} from '../../../../shared/pty-process-inspection-evidence'
import { guardRunningTerminalClose } from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('terminal-tab close on PTY absence evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } } },
      agentStatusByPaneKey: {}
    })
  })

  async function closeTab(): Promise<ReturnType<typeof vi.fn>> {
    const onClose = vi.fn()
    guardRunningTerminalClose({ terminalTabId: 'tab-1', tabLabel: 'npm run dev', onClose })
    await settleProbe()
    return onClose
  }

  it('asks before closing when the host lost the route to the pane', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(buildAbsentPtyInspection('unverifiable'))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes silently on a local exit the provider watched', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(buildAbsentPtyInspection('exited'))

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before closing a pane with a live child process', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'node' },
        { verdict: 'live' }
      )
    )

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves a degraded in-contact probe on its existing close-silently behavior', async () => {
    // Loss of contact with the child-process probe on a pane the host still routes to:
    // no `unavailable`, so this guard reaches no new verdict and behaves as it always has.
    inspectRuntimeTerminalProcessMock.mockResolvedValue(
      buildPtyProcessInspectionWireResult(
        { verdict: 'unverifiable', reason: 'process table scan degraded' },
        { verdict: 'unverifiable', reason: 'process table scan degraded' }
      )
    )

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
