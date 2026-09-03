import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostWorkspaceOperations } from './native-host-workspace-operations'

describe('native host workspace operations', () => {
  it('does not relay its connection state, so a first failure stays a failure', () => {
    const client = { sendRequest: vi.fn(), notifyForeground: vi.fn(), subscribe: vi.fn() }

    expect(
      nativeHostWorkspaceOperations(client as unknown as RpcClient).connectionStateIsRelayed
    ).toBeUndefined()
  })

  it('maps named reads and mutations to the existing RPC authority', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({ ok: true, result: { ui: { sortBy: 'recent' } } })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: { repos: [{ id: 'repo-1' }] } })
      .mockResolvedValueOnce({ ok: true, result: { worktrees: [{ worktreeId: 'workspace-1' }] } })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: {} })
    const client = {
      sendRequest,
      notifyForeground: vi.fn(),
      subscribe: vi.fn(() => vi.fn())
    } as unknown as RpcClient
    const operations = nativeHostWorkspaceOperations(client)

    await operations.getViewSettings()
    await operations.setViewSettings({ sortBy: 'recent' })
    await operations.listRepos()
    await operations.listWorkspaces(200)
    await operations.setPinned('workspace-1', true)
    await operations.activateWorkspace('workspace-1')
    await operations.sleepWorkspace('workspace-1')
    await expect(operations.removeWorkspace('workspace-1')).resolves.toBe(true)

    expect(sendRequest.mock.calls).toEqual([
      ['ui.get'],
      ['ui.set', { sortBy: 'recent' }],
      ['repo.list'],
      ['worktree.ps', { limit: 200 }],
      ['worktree.set', { worktree: 'id:workspace-1', isPinned: true }],
      [
        'worktree.activate',
        {
          worktree: 'id:workspace-1',
          notifyClients: false,
          navigation: 'caller'
        }
      ],
      ['worktree.sleep', { worktree: 'id:workspace-1' }],
      ['worktree.rm', { worktree: 'id:workspace-1', force: true }]
    ])
  })

  it('filters the generic host event stream into named workspace changes', () => {
    let receive: ((payload: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    const client = {
      sendRequest: vi.fn(),
      notifyForeground: vi.fn(),
      subscribe: vi.fn((_method, _params, listener) => {
        receive = listener
        return unsubscribe
      })
    } as unknown as RpcClient
    const listener = vi.fn()

    const cleanup = nativeHostWorkspaceOperations(client).subscribeChanges(listener)
    receive?.({ type: 'worktreesChanged' })
    receive?.({ type: 'terminalData', secret: 'must-not-forward' })
    cleanup()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ type: 'worktreesChanged' })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
