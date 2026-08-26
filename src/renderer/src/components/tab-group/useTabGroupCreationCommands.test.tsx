// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalCreateRoutingOutcome } from '@/lib/terminal-create-routing-outcome'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('../../runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

import { useAppStore } from '../../store'
import { useTabGroupCreationCommands } from './useTabGroupCreationCommands'

function renderCommands() {
  return renderHook(() =>
    useTabGroupCreationCommands({
      groupId: 'group-1',
      worktreeId: 'wt-1',
      worktreeState: { mobileEmulatorEnabled: false } as never
    })
  )
}

function seedTerminalOutcome(outcome: TerminalCreateRoutingOutcome): void {
  useAppStore.setState({
    openNewTerminalTabInActiveWorkspace: vi.fn(async () => outcome)
  })
}

describe('useTabGroupCreationCommands new terminal failures', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
  })

  it('tells the user why a routed terminal never opened', async () => {
    seedTerminalOutcome({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    const { result } = renderCommands()

    result.current.newTerminalTab()
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not open a new terminal. The workspace is not connected to a remote Orca host.'
    )
  })

  it('explains unroutable ownership without claiming the host is gone', async () => {
    seedTerminalOutcome({
      status: 'unroutable',
      message: 'Orca cannot tell which execution host owns this workspace.'
    })
    const { result } = renderCommands()

    result.current.newTerminalTab()
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))

    expect(mocks.toastError.mock.calls[0]?.[0]).not.toMatch(/\b(exited|dead|stopped|offline)\b/i)
  })

  it('stays silent when the terminal opened or no workspace was active', async () => {
    for (const outcome of [
      { status: 'created' },
      { status: 'no-active-workspace' }
    ] as TerminalCreateRoutingOutcome[]) {
      seedTerminalOutcome(outcome)
      const { result } = renderCommands()
      result.current.newTerminalTab()
      await Promise.resolve()
    }

    await vi.waitFor(() => expect(mocks.toastError).not.toHaveBeenCalled())
  })
})
