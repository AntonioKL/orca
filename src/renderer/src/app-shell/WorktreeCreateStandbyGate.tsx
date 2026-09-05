import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId,
  resolveComposerGitRepoId
} from '../lib/new-workspace-composer-repo'
import { settingsForKnownRepoOwner } from '../store/slices/worktrees/listing/worktree-owner-settings'
import { getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { isWebClientLocation } from '../lib/web-client-location'
import { scheduleAfterInputQuiet } from '../lib/input-quiet-scheduler'
import { isWindowVisible } from '../lib/window-visibility-interval'
import { getRepoExecutionHostId } from '../../../shared/execution-host'

type StandbyState = Pick<AppState, 'repos' | 'projects' | 'activeRepoId' | 'workspaceHostScope'> & {
  draftRepoId: string | null | undefined
  draftBaseBranch: string | undefined
  activeRuntimeEnvironmentId: string | null | undefined
  workspaceDir: string | undefined
  nestWorkspaces: boolean | undefined
  localWindowsRuntimeDefault:
    | NonNullable<AppState['settings']>['localWindowsRuntimeDefault']
    | undefined
}

function standbyIdentity(state: StandbyState): string | null {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  const repoId = resolveComposerGitRepoId({
    eligibleRepos,
    activeRepoId: resolveComposerActiveRepoId(state.repos, eligibleRepos, state.activeRepoId),
    draftRepoId: state.draftRepoId,
    focusedHostScope: state.workspaceHostScope
  })
  const repo = eligibleRepos.find((candidate) => candidate.id === repoId)
  if (
    !repo ||
    repo.connectionId ||
    getRepoExecutionHostId(repo) !== 'local' ||
    getActiveRuntimeTarget(
      settingsForKnownRepoOwner(
        { activeRuntimeEnvironmentId: state.activeRuntimeEnvironmentId } as AppState['settings'],
        repo
      )
    ).kind !== 'local'
  ) {
    return null
  }
  const project = state.projects.find((entry) => entry.sourceRepoIds.includes(repo.id))
  return JSON.stringify({
    repoId: repo.id,
    path: repo.path,
    worktreeBaseRef: repo.worktreeBaseRef,
    worktreeBasePath: repo.worktreeBasePath,
    workspaceDir: state.workspaceDir,
    nestWorkspaces: state.nestWorkspaces,
    projectId: project?.id,
    projectRuntime: project?.localWindowsRuntimePreference,
    localWindowsRuntimeDefault: state.localWindowsRuntimeDefault,
    baseBranch: state.draftRepoId === repo.id ? state.draftBaseBranch : undefined
  })
}

export function WorktreeCreateStandbyGate({ enabled }: { enabled: boolean }): null {
  // The host replenishes consumed standbys; unrelated workspace changes stay quiet.
  const inputs = useAppStore(
    useShallow((state): StandbyState => ({
      repos: state.repos,
      projects: state.projects,
      activeRepoId: state.activeRepoId,
      workspaceHostScope: state.workspaceHostScope,
      draftRepoId: state.newWorkspaceDraft?.repoId,
      draftBaseBranch: state.newWorkspaceDraft?.baseBranch,
      activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId,
      workspaceDir: state.settings?.workspaceDir,
      nestWorkspaces: state.settings?.nestWorkspaces,
      localWindowsRuntimeDefault: state.settings?.localWindowsRuntimeDefault
    }))
  )
  const identity = useMemo(() => standbyIdentity(inputs), [inputs])
  useEffect(() => {
    const setStandby = window.api?.worktrees?.setCreateStandby
    if (!enabled || !identity || isWebClientLocation() || !setStandby) {
      return
    }
    const { repoId, baseBranch } = JSON.parse(identity) as {
      repoId: string
      baseBranch?: string
    }
    let cancelScheduled: (() => void) | undefined
    let requested = false
    const release = (): void => {
      cancelScheduled?.()
      cancelScheduled = undefined
      if (requested) {
        requested = false
        void setStandby({ repoId: null }).catch(() => {})
      }
    }
    const reconcile = (): void => {
      release()
      if (!isWindowVisible()) {
        return
      }
      cancelScheduled = scheduleAfterInputQuiet(
        () => {
          requested = true
          void setStandby({ repoId, ...(baseBranch ? { baseBranch } : {}) }).catch(() => {})
        },
        { delayMs: 2_000, quietMs: 2_000, idleTimeoutMs: 1_000 }
      )
    }
    reconcile()
    document.addEventListener('visibilitychange', reconcile)
    return () => {
      document.removeEventListener('visibilitychange', reconcile)
      release()
    }
  }, [enabled, identity])
  return null
}
