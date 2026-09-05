// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const boundaries = vi.hoisted(() => ({
  create:
    vi.fn<
      (
        id: string,
        request: WorktreeCreationRequest,
        background?: boolean
      ) => Promise<CreateWorktreeResult>
    >(),
  capabilities: vi.fn<() => Promise<string[]>>(),
  activate:
    vi.fn<(request: WorktreeCreationRequest, creation?: Promise<CreateWorktreeResult>) => void>()
}))
vi.mock('@/lib/create-requested-worktree', () => ({ createRequestedWorktree: boundaries.create }))
vi.mock('@/lib/worktree-creation-flow', () => ({
  runBackgroundWorktreeCreation: boundaries.activate
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilities: () => [],
  refreshLocalRuntimeCapabilities: boundaries.capabilities
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { useQuickCreationExecution } from './quick-creation-execution'

type Input = Parameters<typeof useQuickCreationExecution>[0]
type Prepared = NonNullable<Awaited<ReturnType<Input['prepareQuickSubmit']>>>
const repo = {
  id: 'repo',
  displayName: 'Repo',
  path: '/repo',
  connectionId: null,
  badgeColor: 'blue',
  addedAt: 0
} as Repo
const result = {
  worktree: { id: 'retained', repoId: 'repo', path: '/repo/draft' },
  startupTerminal: { spawned: true, tabId: 'warm-tab' }
} as CreateWorktreeResult

function prepared(name = 'draft'): Prepared {
  return {
    submitLinkedWorkItem: null,
    agent: null,
    submitLinkedIssueNumber: null,
    submitLinkedPR: null,
    workspaceName: name,
    nameWasGenerated: false,
    nameIsAutoManaged: false,
    effectiveSetupDecision: 'inherit',
    pendingFirstAgentMessageRename: false,
    trimmedNote: '',
    submitBaseBranch: 'main'
  } as Prepared
}

function makeInput(): Input {
  return {
    clearNewWorkspaceDraft: vi.fn(),
    createMultiple: false,
    effectivePresetId: null,
    ephemeralVmRecipes: [],
    ephemeralVmsEnabled: false,
    isSubmissionCancelled: () => false,
    linkedGitLabIssue: null,
    linkedGitLabMR: null,
    normalizedSparseDirectories: [],
    onCreated: vi.fn(),
    parentWorktreeId: null,
    persistDraft: true,
    persistSetupAgentStartupPolicy: vi.fn(async () => true),
    prepareQuickSubmit: vi.fn(async () => prepared()),
    resetForNextCreate: vi.fn(),
    resolvedInitialWorkspaceStatus: undefined,
    selectedEphemeralVmRecipeId: null,
    selectedRepoAgentLaunchPlatform: 'darwin',
    selectedRepoExecutionHostId: 'local',
    selectedRepoIsGit: true,
    selectedRepoIsRemote: false,
    selectedRepoSettings: null,
    selectedRepoStartupShell: undefined,
    selectedWorkspaceTarget: { status: 'unavailable', reason: 'no-eligible-repo' },
    settings: null,
    sparseEnabled: false,
    taskSourceContext: null,
    telemetrySource: undefined
  } as Input
}

let execution: ReturnType<typeof useQuickCreationExecution>
function Probe({ input }: { input: Input }): null {
  execution = useQuickCreationExecution(input)
  return null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('quick composer retained creation', () => {
  let root: Root | null
  let input: Input
  beforeEach(() => {
    vi.clearAllMocks()
    boundaries.create.mockResolvedValue(result)
    boundaries.capabilities.mockResolvedValue(['worktree.background-startup.v1'])
    input = makeInput()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(createElement(Probe, { input })))
  })
  afterEach(() => {
    act(() => root?.unmount())
    document.body.replaceChildren()
  })

  const execute = (preparation?: { isCancelled: () => boolean }, selectedRepo = repo) =>
    execution.executeQuickCreation(
      { kind: 'none' },
      null,
      'draft',
      null,
      'repo',
      selectedRepo,
      preparation
    )

  it('prepares once without clearing the draft or closing, then joins the same pending creation', async () => {
    const pending = deferred<CreateWorktreeResult>()
    boundaries.create.mockReturnValue(pending.promise)
    await act(async () => {
      await execute({ isCancelled: () => false })
    })
    await act(async () => {
      await execute({ isCancelled: () => false })
    })
    expect(boundaries.create).toHaveBeenCalledTimes(1)
    expect(boundaries.create.mock.calls[0][1]).toMatchObject({
      name: 'draft',
      baseBranch: 'main',
      startup: { command: '' },
      agent: null
    })
    expect(input.clearNewWorkspaceDraft).not.toHaveBeenCalled()
    expect(input.onCreated).not.toHaveBeenCalled()
    expect(input.persistSetupAgentStartupPolicy).not.toHaveBeenCalled()
    expect(boundaries.activate).not.toHaveBeenCalled()

    await act(async () => {
      await execute()
    })
    expect(boundaries.create).toHaveBeenCalledTimes(1)
    expect(boundaries.activate).toHaveBeenCalledTimes(1)
    const joined = boundaries.activate.mock.calls[0][1]
    expect(joined).toBeInstanceOf(Promise)
    pending.resolve(result)
    expect(await joined).toBe(result)
    expect(input.clearNewWorkspaceDraft).toHaveBeenCalledTimes(1)
    expect(input.onCreated).toHaveBeenCalledTimes(1)
  })

  it('uses ordinary Create when the host cannot promise background startup', async () => {
    boundaries.capabilities.mockResolvedValue([])
    await act(async () => {
      await execute({ isCancelled: () => false })
    })
    expect(boundaries.create).not.toHaveBeenCalled()
    await act(async () => {
      await execute()
    })
    expect(boundaries.activate).toHaveBeenCalledWith(expect.any(Object), undefined)
  })

  it('allows one new preparation after an explicit Create more submission', async () => {
    input = { ...input, createMultiple: true }
    act(() => root!.render(createElement(Probe, { input })))
    await act(async () => {
      await execute({ isCancelled: () => false })
      await execute()
    })
    expect(input.resetForNextCreate).toHaveBeenCalledTimes(1)
    vi.mocked(input.prepareQuickSubmit).mockResolvedValue(prepared('next'))
    await act(async () => {
      await execute({ isCancelled: () => false })
      await execute({ isCancelled: () => false })
    })
    expect(boundaries.create).toHaveBeenCalledTimes(2)
    expect(boundaries.create.mock.calls[1][1].name).toBe('next')
  })

  it('does not create if preparation is canceled while preflight is pending', async () => {
    const preflight = deferred<Prepared>()
    vi.mocked(input.prepareQuickSubmit).mockReturnValue(preflight.promise)
    let cancelled = false
    const work = execute({ isCancelled: () => cancelled })
    cancelled = true
    preflight.resolve(prepared())
    await act(async () => {
      await work
    })
    expect(boundaries.create).not.toHaveBeenCalled()
    expect(boundaries.activate).not.toHaveBeenCalled()
    expect(input.clearNewWorkspaceDraft).not.toHaveBeenCalled()
  })

  it.each(['request', 'repository', 'execution settings'] as const)(
    'does not adopt a retained workspace after changing %s',
    async (change) => {
      await act(async () => {
        await execute({ isCancelled: () => false })
      })
      let selectedRepo = repo
      if (change === 'request') {
        vi.mocked(input.prepareQuickSubmit).mockResolvedValue(prepared('different'))
      } else if (change === 'repository') {
        selectedRepo = { ...repo, path: '/different-root' }
      } else {
        input = { ...input, selectedRepoStartupShell: 'powershell' }
        act(() => root!.render(createElement(Probe, { input })))
      }
      await act(async () => {
        await execute(undefined, selectedRepo)
      })
      expect(boundaries.create).toHaveBeenCalledTimes(1)
      expect(boundaries.activate).toHaveBeenCalledWith(expect.any(Object), undefined)
    }
  )

  it('keeps creation alive after composer unmount without activation or cleanup', async () => {
    const pending = deferred<CreateWorktreeResult>()
    boundaries.create.mockReturnValue(pending.promise)
    await act(async () => {
      await execute({ isCancelled: () => false })
    })
    act(() => root!.unmount())
    root = null
    pending.resolve(result)
    await expect(pending.promise).resolves.toBe(result)
    expect(boundaries.create).toHaveBeenCalledTimes(1)
    expect(boundaries.create.mock.calls[0][2]).toBe(true)
    expect(boundaries.activate).not.toHaveBeenCalled()
    expect(input.clearNewWorkspaceDraft).not.toHaveBeenCalled()
    expect(input.onCreated).not.toHaveBeenCalled()
  })
})
