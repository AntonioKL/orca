// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { useTargetChangeActions } from './target-change-actions'

const readyOption: ProjectHostSetupOption = {
  kind: 'ready',
  id: 'setup-side',
  projectId: 'github:stablyai/orca',
  hostId: 'local',
  repoId: 'orca-side',
  label: 'Local Mac',
  detail: 'orca',
  path: '/checkouts/side'
}

function renderTargetChangeActions() {
  const spies = {
    setRepoId: vi.fn(),
    setProjectError: vi.fn(),
    setSelectedProjectHostSetupOverrideId: vi.fn(),
    setSelectedProjectIdOverride: vi.fn()
  }
  const noop = vi.fn()
  const { result } = renderHook(() =>
    useTargetChangeActions({
      baseBranch: undefined,
      branchAutoNameRef: { current: null },
      decisions: { retargetGitHubPrStartPointSelection: (selection: unknown) => selection },
      folderSourceRepos: [],
      hostOptions: [],
      linkedWorkItem: null,
      projectHostSetupOptions: [readyOption],
      repoId: '',
      selectedRepoProjectId: 'github:stablyai/orca',
      setBaseBranch: noop,
      setBranchNameOverride: noop,
      setBranchNameOverridePreservesNameEdits: noop,
      setCompareBaseRef: noop,
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
      smartGitHubPrStartPointSelectionRef: { current: null },
      ...spies
    } as unknown as Parameters<typeof useTargetChangeActions>[0])
  )
  return { actions: result.current, spies }
}

describe('choosing a run target closes the pending checkout question (STA-6080)', () => {
  it('clears the pending project when a setup is picked', () => {
    const { actions, spies } = renderTargetChangeActions()

    actions.handleProjectHostSetupChange('setup-side')

    expect(spies.setSelectedProjectHostSetupOverrideId).toHaveBeenCalledWith('setup-side')
    expect(spies.setSelectedProjectIdOverride).toHaveBeenCalledWith(null)
    expect(spies.setRepoId).toHaveBeenCalledWith('orca-side')
  })

  it('clears the pending project when a repo is chosen directly', () => {
    const { actions, spies } = renderTargetChangeActions()

    actions.handleRepoChange('orca-main')

    expect(spies.setSelectedProjectIdOverride).toHaveBeenCalledWith(null)
  })
})
