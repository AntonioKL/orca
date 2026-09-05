import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { makePaneKey } from '../../../../shared/stable-pane-id'
const { handlers, supports, release, ownership } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  supports: vi.fn(async () => true),
  release: vi.fn(async () => 'accepted'),
  ownership: new Map<string, string | null>()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) }
}))
vi.mock('../../pty/provider/ownership-state', () => ({ ptyOwnership: ownership }))
vi.mock('../../pty/runtime/deferred-startup', () => ({
  supportsDeferredStartupFromRuntimeController: supports,
  releaseStartupFromRuntimeController: release
}))
vi.mock('../../pty/pane/stable-owner', () => ({
  resolvePersistedStablePaneOwner: (store: WorktreeIpcContext['store'], key: string) => ({
    incarnationId: store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[key]
  })
}))
import { registerWorktreeDeferredStartupHandlers } from './register-worktree-deferred-startup-handlers'

describe('composer deferred startup admission and release', () => {
  const repo = { id: 'repo', path: '/repo', name: 'repo' }
  const session = {
    tabsByWorktree: { workspace: [{ id: 'tab', worktreeId: 'workspace' }] },
    terminalLayoutsByTabId: {
      tab: { ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty' } }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey('tab', '11111111-1111-4111-8111-111111111111')]: 'incarnation'
    }
  }
  const store = { getRepo: vi.fn((): unknown => repo), getWorkspaceSession: () => session }
  const args = {
    worktreeId: 'workspace',
    ptyId: 'pty',
    expectedIncarnationId: 'incarnation',
    operationId: 'operation'
  }
  beforeEach(() => {
    vi.clearAllMocks()
    supports.mockResolvedValue(true)
    ownership.clear()
    ownership.set('pty', null)
    store.getRepo.mockReturnValue(repo)
    registerWorktreeDeferredStartupHandlers({ store } as unknown as WorktreeIpcContext)
  })
  it('requires a supporting provider for the local repo', async () => {
    expect(await handlers.get('worktrees:supportsDeferredStartup')!(null, 'repo')).toBe(true)
    supports.mockResolvedValue(false)
    expect(await handlers.get('worktrees:supportsDeferredStartup')!(null, 'repo')).toBe(false)
  })
  it.each([
    { executionHostId: 'ssh:host' },
    { executionHostId: 'runtime:host' },
    { kind: 'folder' }
  ])('never probes a nonnative owner %j', async (extra) => {
    store.getRepo.mockReturnValue({ ...repo, ...extra })
    expect(await handlers.get('worktrees:supportsDeferredStartup')!(null, 'repo')).toBe(false)
    expect(supports).not.toHaveBeenCalled()
  })
  it('releases only the exact persisted workspace process', async () => {
    expect(await handlers.get('worktrees:releaseStartup')!(null, args)).toBe('accepted')
    expect(release).toHaveBeenCalledWith('pty', 'incarnation', 'operation')
  })
  it.each([{ worktreeId: 'other' }, { ptyId: 'other' }, { expectedIncarnationId: 'old' }])(
    'does not release a mismatched identity %j',
    async (override) => {
      expect(
        await handlers.get('worktrees:releaseStartup')!(null, { ...args, ...override })
      ).not.toBe('accepted')
      expect(release).not.toHaveBeenCalled()
    }
  )
  it('does not route a retained remote process through local release', async () => {
    ownership.set('pty', 'ssh')
    expect(await handlers.get('worktrees:releaseStartup')!(null, args)).toBe('unavailable')
    expect(release).not.toHaveBeenCalled()
  })
})
