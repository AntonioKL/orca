import { describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { makeRequest } from './worktree-creation-request.test-fixture'
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'

const { store } = vi.hoisted(() => ({
  store: {
    settings: {},
    pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
    beginPendingWorktreeCreation: vi.fn(),
    setActiveView: vi.fn(),
    setSidebarOpen: vi.fn()
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'new-id' }))
vi.mock('@/lib/worktree-creation-flow-execute', () => ({ executeWorktreeCreation: vi.fn() }))
vi.mock('@/lib/worktree-creation-structured-recovery', () => ({
  retryStructuredWorktreeLaunch: vi.fn()
}))

describe('retained checkout progress correlation', () => {
  it('uses the backend reservation ID for both the pending panel and completion', () => {
    const request = makeRequest()
    const creation = new Promise<CreateWorktreeResult>(() => {})
    const id = runBackgroundWorktreeCreation(request, creation, {
      creationId: 'reservation-id',
      phase: 'creating'
    })
    expect(id).toBe('reservation-id')
    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ creationId: 'reservation-id', phase: 'creating', request })
    )
    expect(executeWorktreeCreation).toHaveBeenCalledExactlyOnceWith(
      'reservation-id',
      request,
      creation
    )
  })
})
