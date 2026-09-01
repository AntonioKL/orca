// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { useProjectTargetActions } from './project-target-actions'

const PROJECT_ID = 'github:stablyai/orca'

function makeRepo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path, displayName: id, badgeColor: '#000000', addedAt: 1, ...overrides }
}

function makeSetup(id: string, hostId: ExecutionHostId, repoId: string, path: string) {
  return {
    id,
    projectId: PROJECT_ID,
    hostId,
    repoId,
    path,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  } satisfies ProjectHostSetup
}

const project: Project = {
  id: PROJECT_ID,
  displayName: 'orca',
  badgeColor: '#000000',
  sourceRepoIds: ['orca-main', 'orca-side'],
  createdAt: 1,
  updatedAt: 1
}

function renderProjectTargetActions(projectHostSetups: readonly ProjectHostSetup[]) {
  const spies = {
    handleRepoChange: vi.fn(),
    setProjectError: vi.fn(),
    setRepoId: vi.fn(),
    setSelectedProjectGroupId: vi.fn(),
    setSelectedProjectHostSetupOverrideId: vi.fn(),
    setSelectedProjectIdOverride: vi.fn()
  }
  const noop = vi.fn()
  const { result } = renderHook(() =>
    useProjectTargetActions({
      actionableHostIds: new Set<ExecutionHostId>(['local']),
      eligibleRepos: [
        makeRepo('orca-main', '/checkouts/main'),
        makeRepo('orca-side', '/checkouts/side')
      ],
      initialProjectGroupAppliedRef: { current: false },
      isProjectGroupTarget: false,
      linkedWorkItem: null,
      projectGroups: [],
      projectHostSetups,
      projects: [project],
      repos: [],
      selectedWorkspaceTarget: { status: 'unavailable', reason: 'project-has-no-ready-setup' },
      workspaceHostScope: 'all',
      setBaseBranch: noop,
      setBranchNameOverride: noop,
      setBranchNameOverridePreservesNameEdits: noop,
      setForkPushWarning: noop,
      setLinkedGitLabIssue: noop,
      setLinkedGitLabMR: noop,
      setLinkedIssue: noop,
      setLinkedPR: noop,
      setLinkedTaskSourceContext: noop,
      setLinkedWorkItem: noop,
      setPushTarget: noop,
      setReuseEligibleBranch: noop,
      setReuseSelectedBranch: noop,
      setSparseDirectories: noop,
      setSparseEnabled: noop,
      setSparseSelectedPresetId: noop,
      setStartFromResetHint: noop,
      ...spies
    } as unknown as Parameters<typeof useProjectTargetActions>[0])
  )
  return { handleProjectChange: result.current.handleProjectChange, spies }
}

describe('composer project switch with several ready setups (STA-6080)', () => {
  it('keeps the project selected and asks for a checkout instead of creating in the first', () => {
    const { handleProjectChange, spies } = renderProjectTargetActions([
      makeSetup('setup-main', 'local', 'orca-main', '/checkouts/main'),
      makeSetup('setup-side', 'local', 'orca-side', '/checkouts/side')
    ])

    handleProjectChange(PROJECT_ID)

    expect(spies.setSelectedProjectIdOverride).toHaveBeenCalledWith(PROJECT_ID)
    expect(spies.setSelectedProjectHostSetupOverrideId).toHaveBeenCalledWith(null)
    expect(spies.setRepoId).toHaveBeenCalledWith('')
    expect(spies.handleRepoChange).not.toHaveBeenCalled()
  })

  it('resolves silently when the project has one ready setup', () => {
    const { handleProjectChange, spies } = renderProjectTargetActions([
      makeSetup('setup-main', 'local', 'orca-main', '/checkouts/main')
    ])

    handleProjectChange(PROJECT_ID)

    expect(spies.handleRepoChange).toHaveBeenCalledWith('orca-main', {
      forceResetStartFrom: false
    })
    expect(spies.setSelectedProjectIdOverride).toHaveBeenCalledWith(null)
    expect(spies.setRepoId).not.toHaveBeenCalled()
  })
})
