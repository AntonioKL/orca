import { describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { createRetainedWorktreeCreation } from './retained-worktree-creation'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo',
    name: 'draft',
    baseBranch: 'main',
    setupDecision: 'skip',
    agent: null,
    startup: { command: '', env: { PROJECT: 'original' } },
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

const result = {
  worktree: { id: 'retained', repoId: 'repo', path: '/workspace/draft' },
  startupTerminal: { tabId: 'same-tab', spawned: true }
} as CreateWorktreeResult

describe('retained composer worktree creation', () => {
  it('retains an agent checkout and preserves the exact launch plan for Create', async () => {
    const checkout = { worktree: result.worktree }
    const create = vi.fn(async () => checkout)
    const controller = createRetainedWorktreeCreation(create)
    const agentRequest = request({
      agent: 'codex',
      startup: { command: 'codex', launchAgent: 'codex' },
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentArgs: '', agentEnv: {} }
      },
      launchDraftPrompt: 'Keep this unsent'
    })
    expect(controller.start(agentRequest, 'owner')).toBe(true)
    expect(await controller.take(agentRequest, 'owner')).toBe(checkout)
    expect(create).toHaveBeenCalledExactlyOnceWith(agentRequest)
    expect(controller.take(agentRequest, 'owner')).toBeNull()
  })

  it('retains a remote blank checkout whose terminal starts on activation', async () => {
    const create = vi.fn(async () => ({ worktree: result.worktree }))
    const controller = createRetainedWorktreeCreation(create)
    const remoteRequest = request({ startup: undefined })
    expect(controller.start(remoteRequest, 'ssh:owner')).toBe(true)
    expect(await controller.take(remoteRequest, 'ssh:owner')).toEqual({ worktree: result.worktree })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]).toEqual([expect.objectContaining({ agent: null })])
  })

  it('joins an unfinished create once, retaining its exact workspace and terminal result', async () => {
    let finish!: (value: CreateWorktreeResult) => void
    const create = vi.fn(() => new Promise<CreateWorktreeResult>((resolve) => (finish = resolve)))
    const controller = createRetainedWorktreeCreation(create)
    const original = request()

    expect(controller.start(original, 'host/root/shell')).toBe(true)
    const adopted = controller.take(original, 'host/root/shell')
    expect(adopted).not.toBeNull()
    expect(controller.take(original, 'host/root/shell')).toBeNull()
    expect(controller.start(original, 'host/root/shell')).toBe(false)
    await Promise.resolve()
    finish(result)
    expect(await adopted).toBe(result)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('adopts an already completed create despite object property insertion order', async () => {
    const create = vi.fn(async () => result)
    const controller = createRetainedWorktreeCreation(create)
    const original = request()
    controller.start(original, 'host')
    await vi.waitFor(() => expect(create).toHaveResolvedWith(result))
    const reordered = Object.fromEntries(
      Object.entries(original).toReversed()
    ) as WorktreeCreationRequest
    expect(controller.take(reordered, 'host')).toBe(result)
  })

  it('isolates and freezes the execution snapshot from subsequent composer edits', async () => {
    const create = vi.fn(async (_snapshot: WorktreeCreationRequest) => result)
    const controller = createRetainedWorktreeCreation(create)
    const original = request()
    controller.start(original, 'host')
    original.startup!.env!.PROJECT = 'edited'
    original.name = 'edited'
    await Promise.resolve()

    const snapshot = create.mock.calls[0][0]
    expect(snapshot.name).toBe('draft')
    expect(snapshot.startup?.env?.PROJECT).toBe('original')
    expect(Object.isFrozen(snapshot.startup?.env)).toBe(true)
    expect(controller.take(original, 'host')).toBeNull()
    expect(controller.start(original, 'host')).toBe(false)
    expect(controller.take(request(), 'host')).toBeNull()
  })

  it.each(['different-host', 'different-root', 'different-shell', 'different-environment'])(
    'refuses adoption after changing execution identity to %s',
    (identity) => {
      const controller = createRetainedWorktreeCreation(async () => result)
      controller.start(request(), 'original')
      expect(controller.take(request(), identity)).toBeNull()
      expect(controller.take(request(), 'original')).toBeNull()
    }
  )

  it('finishes ordinary creation when the composer cancels before create begins', async () => {
    const create = vi.fn(async () => result)
    const controller = createRetainedWorktreeCreation(create)
    controller.start(request(), 'host')
    controller.retire()
    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    expect(controller.take(request(), 'host')).toBeNull()
    expect(controller.start(request(), 'host')).toBe(false)
  })

  it('preserves failure for a matching submit without automatically creating again', async () => {
    const failure = new Error('host contact lost; outcome unknown')
    const create = vi.fn(async () => {
      throw failure
    })
    const controller = createRetainedWorktreeCreation(create)
    controller.start(request(), 'host')
    await expect(controller.take(request(), 'host')).rejects.toBe(failure)
    expect(controller.start(request(), 'host')).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each<Partial<WorktreeCreationRequest>>([
    { agent: 'claude' },
    { startup: { command: 'agent' } },
    { startup: { command: '', launchAgent: 'claude' } },
    { issueCommand: { command: 'automation' } },
    { launchDraftPrompt: 'send this' },
    { agentLaunchRoute: 'structured-native-chat' },
    { ephemeralVmRecipe: { sourceRepoId: 'repo', recipeId: 'vm', projectId: 'project' } },
    { ephemeralVmRuntimeId: 'vm' },
    { ephemeralVmRuntimeEnvironmentId: 'runtime' },
    { ephemeralVmCheckoutMode: 'provisioned-root' },
    { ephemeralVmExpectedRefHead: 'commit' }
  ])('refuses unsafe early launch work: %j', (override) => {
    const create = vi.fn(async () => result)
    const controller = createRetainedWorktreeCreation(create)
    expect(controller.start(request(override), 'host')).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(controller.start(request(), 'host')).toBe(true)
  })
})
