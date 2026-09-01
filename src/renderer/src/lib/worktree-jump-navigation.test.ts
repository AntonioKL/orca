import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  getVisibleWorktreeShortcutTargets: vi.fn(),
  warning: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/components/sidebar/visible-worktrees', () => ({
  getVisibleWorktreeShortcutTargets: mocks.getVisibleWorktreeShortcutTargets
}))
vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }))

import { jumpToWorktreeFromSidebar } from './worktree-jump-navigation'

describe('worktree jump navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([])
    mocks.getState.mockReturnValue({
      sidebarBody: 'agents',
      setSidebarBody: vi.fn(),
      worktreesByRepo: { repo: [] },
      showSleepingWorkspaces: true,
      filterRepoIds: ['other-repo'],
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      alwaysShowDefaultBranchWorkspace: true,
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all'
    })
  })

  it('switches the left sidebar to Spaces and warns when filters hide the target', () => {
    const state = mocks.getState()

    expect(jumpToWorktreeFromSidebar('repo::/target')).toBe(true)

    expect(state.setSidebarBody).toHaveBeenCalledWith('workspaces')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::/target', {
      revealInSidebar: false,
      clearSidebarFilters: false
    })
    expect(mocks.warning).toHaveBeenCalledOnce()
  })

  it('does not warn when the target is visible', () => {
    mocks.getVisibleWorktreeShortcutTargets.mockReturnValue([{ id: 'wt-1' }])

    jumpToWorktreeFromSidebar('wt-1')

    expect(mocks.warning).not.toHaveBeenCalled()
  })
})
