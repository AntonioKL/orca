// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => true),
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => 'runtime-1' as string | null),
  createTab: vi.fn(() => ({ id: 'tab-1' }))
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  createFloatingWorkspaceTerminalTab: vi.fn(),
  isEmptyFloatingWorkspacePanelVisible: () => false,
  isFloatingWorkspacePanelFocused: () => false,
  resolveFloatingWorkspaceBrowserWorkspaceId: () => null,
  switchFloatingWorkspaceTab: vi.fn()
}))

import { useAppStore } from '../../store'
import { registerTabLifecycleIpcBridge } from './tab-lifecycle-ipc-bridge'

function registerAndCaptureNewTerminalHandler(): () => void {
  let handler: () => void = () => {}
  const noopUnsubscribe = (): void => {}
  const listen = (): (() => void) => noopUnsubscribe
  ;(window as unknown as { api: unknown }).api = {
    ui: {
      onNewTerminalTab: (callback: () => void) => {
        handler = callback
        return noopUnsubscribe
      },
      onCloseActiveTab: listen,
      onCloseFloatingItem: listen,
      onSelectFloatingIndex: listen,
      onSwitchTab: listen,
      onSwitchTabAcrossAllTypes: listen,
      onSwitchRecentTab: listen,
      onSwitchTerminalTab: listen
    }
  }
  registerTabLifecycleIpcBridge([])
  return () => handler()
}

describe('menu New Terminal Tab failures', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.createTab.mockClear()
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    useAppStore.setState({ activeWorktreeId: 'wt-1', createTab: mocks.createTab as never })
  })

  it('explains why the owning runtime opened nothing', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })

    registerAndCaptureNewTerminalHandler()()
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not open a new terminal. The workspace is not connected to a remote Orca host.'
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('keeps the silent local fallback when no runtime owns the workspace', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)

    registerAndCaptureNewTerminalHandler()()
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalledTimes(1))

    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
