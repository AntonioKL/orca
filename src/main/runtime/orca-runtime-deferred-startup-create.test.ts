import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_PATH } from './orca-runtime-test-fixtures.spec'

describe('runtime deferred startup creation', () => {
  function setup() {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockResolvedValue({ id: 'deferred-pty', incarnationId: 'incarnation' })
    const controller = {
      spawn,
      adoptStablePane: vi.fn(async () => null),
      write: vi.fn(() => true),
      kill: () => true,
      getForegroundProcess: async () => null,
      supportsDeferredStartupCommands: vi.fn(async () => true),
      releaseStartupCommand: vi.fn(async () => 'accepted' as const)
    }
    runtime.setPtyController(controller)
    return { runtime, controller, spawn }
  }
  const opts = { command: 'codex', deferredStartupOperationId: 'operation', activate: false }
  it('forwards original startup to the provider and returns its incarnation without releasing', async () => {
    const { runtime, controller, spawn } = setup()
    const result = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, opts)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0]).toMatchObject({
      command: expect.stringMatching(/^codex(?: |$)/),
      commandDelivery: 'provider',
      deferredStartupOperationId: 'operation'
    })
    expect(result).toMatchObject({ ptyId: 'deferred-pty', incarnationId: 'incarnation' })
    expect(controller.adoptStablePane).not.toHaveBeenCalled()
    expect(controller.releaseStartupCommand).not.toHaveBeenCalled()
    expect(controller.write).not.toHaveBeenCalled()
  })
  it.each([
    { rendererBacked: true },
    { focus: true },
    { sessionId: 'existing' },
    { tabId: 'existing-tab' }
  ])('rejects non-fresh or renderer ownership %j', async (extra) => {
    const { runtime, spawn } = setup()
    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { ...opts, ...extra })
    ).rejects.toThrow('deferred_startup_requires_fresh')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('requires a release port even if capability is advertised', async () => {
    const { runtime, controller, spawn } = setup()
    runtime.setPtyController({ ...controller, releaseStartupCommand: undefined })
    await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, opts)).rejects.toThrow(
      'deferred_startup_unavailable'
    )
    expect(spawn).not.toHaveBeenCalled()
  })
  it('requires provider support before any spawn', async () => {
    const { runtime, controller, spawn } = setup()
    controller.supportsDeferredStartupCommands.mockResolvedValue(false)
    await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, opts)).rejects.toThrow(
      'deferred_startup_unavailable'
    )
    expect(spawn).not.toHaveBeenCalled()
  })
})
