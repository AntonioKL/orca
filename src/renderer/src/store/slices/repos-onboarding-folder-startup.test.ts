import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeWorktree } from './store-test-helpers'

const worktreeActivation = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn()
}))

// This store path resolves the launch route, which asks whether the renderer is
// a paired web client. The test's window stub has no `location`, so mock the
// module rather than reaching into window — the convention 7 other suites use.
vi.mock('../../lib/web-client-location', () => ({
  isWebClientLocation: () => false
}))

vi.mock('../../lib/worktree-activation', () => ({
  activateAndRevealWorktree: worktreeActivation.activateAndRevealWorktree
}))

const reposAdd = vi.fn()
const worktreesList = vi.fn()
const onboardingGet = vi.fn()

beforeEach(() => {
  reposAdd.mockReset()
  worktreesList.mockReset()
  onboardingGet.mockReset()
  worktreeActivation.activateAndRevealWorktree.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { add: reposAdd },
      worktrees: { list: worktreesList },
      onboarding: { get: onboardingGet }
    }
  })
})

describe('repo slice skipped-onboarding folder startup', () => {
  it('only seeds the onboarding default agent for the first dismissed-onboarding folder', async () => {
    reposAdd
      .mockResolvedValueOnce({
        repo: { id: 'folder-1', path: '/first', displayName: 'First', addedAt: 1 }
      })
      .mockResolvedValueOnce({
        repo: { id: 'folder-2', path: '/second', displayName: 'Second', addedAt: 2 }
      })
    worktreesList.mockImplementation(({ repoId }: { repoId: string }) => [
      makeWorktree({ id: `${repoId}::/folder`, repoId })
    ])
    onboardingGet.mockResolvedValue({ ...getDefaultOnboardingState(), outcome: 'dismissed' })
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex'
      }
    })

    await store.getState().addNonGitFolder('/first')
    await store.getState().addNonGitFolder('/second')

    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      1,
      'folder-1::/folder',
      {
        sidebarRevealBehavior: 'auto',
        startup: {
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          env: {},
          launchAgent: 'codex',
          launchConfig: {
            agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          sessionOptions: undefined,
          telemetry: {
            agent_kind: 'codex',
            launch_source: 'onboarding',
            request_kind: 'new'
          }
        }
      }
    )
    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      2,
      'folder-2::/folder',
      { sidebarRevealBehavior: 'auto' }
    )
  })
})
