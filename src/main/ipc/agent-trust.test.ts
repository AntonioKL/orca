import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handle, markCodexProjectTrusted, markRemoteAgentWorkspaceTrusted } = vi.hoisted(() => ({
  handle: vi.fn(),
  markCodexProjectTrusted: vi.fn<() => Promise<void>>(),
  markRemoteAgentWorkspaceTrusted: vi.fn<() => Promise<void>>()
}))
vi.mock('electron', () => ({ ipcMain: { removeHandler: vi.fn(), handle } }))
vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted,
  markCopilotFolderTrusted: vi.fn(),
  markCursorWorkspaceTrusted: vi.fn()
}))
vi.mock('../remote-agent-trust-presets', () => ({ markRemoteAgentWorkspaceTrusted }))

import { registerAgentTrustHandlers } from './agent-trust'

type TrustHandler = (
  event: unknown,
  args: { preset: 'codex'; workspacePath: string; connectionId?: string }
) => Promise<void>
let handler: TrustHandler
beforeEach(() => {
  vi.clearAllMocks()
  registerAgentTrustHandlers()
  handler = handle.mock.calls.find(([channel]) => channel === 'agentTrust:markTrusted')![1]
})

describe('agent trust IPC ordering', () => {
  it('does not release launch preflight until the queued local trust write settles', async () => {
    let finish!: () => void
    markCodexProjectTrusted.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const settled = vi.fn()
    const preflight = handler(null, { preset: 'codex', workspacePath: '/workspace' }).then(settled)
    await Promise.resolve()
    expect(markCodexProjectTrusted).toHaveBeenCalledExactlyOnceWith('/workspace')
    expect(settled).not.toHaveBeenCalled()
    finish()
    await preflight
    expect(settled).toHaveBeenCalledOnce()
  })

  it('contains an asynchronous trust failure so launch can continue', async () => {
    markCodexProjectTrusted.mockRejectedValue(new Error('config write failed'))
    await expect(
      handler(null, { preset: 'codex', workspacePath: '/workspace' })
    ).resolves.toBeUndefined()
  })

  it('waits for the execution host without writing trust on the client', async () => {
    let finish!: () => void
    markRemoteAgentWorkspaceTrusted.mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve))
    )
    const settled = vi.fn()
    const preflight = handler(null, {
      preset: 'codex',
      workspacePath: '/remote/workspace',
      connectionId: 'ssh-owner'
    }).then(settled)
    await Promise.resolve()
    expect(markCodexProjectTrusted).not.toHaveBeenCalled()
    expect(markRemoteAgentWorkspaceTrusted).toHaveBeenCalledExactlyOnceWith({
      preset: 'codex',
      workspacePath: '/remote/workspace',
      connectionId: 'ssh-owner'
    })
    expect(settled).not.toHaveBeenCalled()
    finish()
    await preflight
    expect(settled).toHaveBeenCalledOnce()
  })
})
