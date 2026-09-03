import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      workspacePath: '/repos/workspace-1',
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
  })

  it('derives WSL ownership from a local folder workspace UNC path', async () => {
    const runtime = new OrcaRuntimeService({ getSettings: () => ({}) } as never)
    const internal = runtime as unknown as {
      store: {
        getRepo: () => undefined
      }
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { id: string; path: string }
        executionHostId: string
      }>
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: string | null
        workspaceId: string
        workspaceKind: 'folder' | 'git-worktree'
      }>
    }
    internal.store = { getRepo: () => undefined }
    internal.resolveRuntimeFileTarget = async () => ({
      worktree: {
        id: 'folder:folder-1',
        path: String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`
      },
      executionHostId: 'local'
    })

    await expect(
      internal.resolveStructuredAgentSessionLocation('id:folder:folder-1')
    ).resolves.toEqual({
      executionHostId: 'local',
      wslDistro: 'Ubuntu',
      workspaceId: 'folder:folder-1',
      workspaceKind: 'folder'
    })
  })

  it('keeps native folder paths native and does not infer WSL ownership for SSH folders', async () => {
    const runtime = new OrcaRuntimeService({ getSettings: () => ({}) } as never)
    const internal = runtime as unknown as {
      store: { getRepo: () => undefined }
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { id: string; path: string }
        executionHostId: string
      }>
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<unknown>
    }
    internal.store = { getRepo: () => undefined }
    internal.resolveRuntimeFileTarget = async (selector) => ({
      worktree: {
        id: 'folder:folder-2',
        path: selector === 'ssh' ? String.raw`\\wsl.localhost\Ubuntu\home\dev\repo` : 'C:\\repo'
      },
      executionHostId: selector === 'ssh' ? 'ssh:ssh-host' : 'local'
    })

    await expect(internal.resolveStructuredAgentSessionLocation('native')).resolves.toMatchObject({
      wslDistro: null,
      workspaceKind: 'folder'
    })
    await expect(internal.resolveStructuredAgentSessionLocation('ssh')).resolves.toMatchObject({
      executionHostId: expect.stringContaining('ssh:'),
      wslDistro: null,
      workspaceKind: 'folder'
    })
  })
})
