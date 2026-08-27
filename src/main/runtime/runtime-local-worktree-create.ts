import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import {
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions
} from '../project-runtime-git-options'
import { getBaseRefDefault, resolveDefaultBaseRefWithLocalGit } from '../git/repo'
import { resolveLocalGitUsername } from '../git/git-username'
import { computeWorkspaceRoot, getWorktreePathSettings } from '../ipc/worktree-logic'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import { hasLocalGitOptions } from './runtime-worktree-selection'
import { hasLocalWorktreeBaseRef } from './runtime-worktree-create-git'
import { resolveRuntimeLocalWorktreeCreateCandidate } from './runtime-local-worktree-create-candidate'
import { createRuntimeLocalGitWorktree } from './runtime-local-git-worktree-create'
import { materializeRuntimeLocalWorktree } from './runtime-local-worktree-materialization'

type LocalGitOptions = { wslDistro?: string }
type LocalGitArgs = [] | [LocalGitOptions]

export async function createRuntimeLocalManagedWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  store: Store
  createdWithAgent: RuntimeManagedWorktreeCreateArgs['createdWithAgent']
  hostedReviewExecutionContext?: { localGitExecOptions: { wslDistro?: string } }
  resolveRemoteTrackingBase: (
    path: string,
    base: string,
    ...options: LocalGitArgs
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    path: string,
    base: RemoteTrackingBase,
    ...options: LocalGitArgs
  ) => Promise<boolean>
  refreshRemoteTrackingBase: (
    path: string,
    base: RemoteTrackingBase,
    ...options: LocalGitArgs
  ) => Promise<RemoteFetchResult>
  fetchRemote: (path: string, remote: string, ...options: LocalGitArgs) => Promise<void>
}) {
  const { request, repo, store } = args
  const settings = store.getSettings()
  const pathSettings = getWorktreePathSettings(repo, settings)
  const gitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const worktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const hasWorktreeGitOptions = hasLocalGitOptions(worktreeGitOptions)
  const worktreeGitArgs: LocalGitArgs = hasWorktreeGitOptions ? [worktreeGitOptions] : []
  const username =
    !request.branchNameOverride && settings.branchPrefix === 'git-username'
      ? await resolveLocalGitUsername(repo.path)
      : ''
  const baseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch: request.baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () =>
      hasWorktreeGitOptions
        ? resolveDefaultBaseRefWithLocalGit(gitExecOptions)
        : getBaseRefDefault(repo.path),
    isBaseUsable: async (candidate) => {
      const remoteBase = await args.resolveRemoteTrackingBase(
        repo.path,
        candidate,
        ...worktreeGitArgs
      )
      if (
        remoteBase &&
        (await args.hasRemoteTrackingRef(repo.path, remoteBase, ...worktreeGitArgs))
      ) {
        return true
      }
      return hasLocalWorktreeBaseRef(
        repo.path,
        candidate,
        hasWorktreeGitOptions ? worktreeGitOptions : {}
      )
    }
  })
  if (!baseBranch) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.'
    )
  }
  const candidate = await resolveRuntimeLocalWorktreeCreateCandidate({
    request,
    repo,
    settings,
    worktreePathSettings: pathSettings,
    workspaceRoot: computeWorkspaceRoot(repo.path, pathSettings),
    username,
    store,
    baseBranch,
    localWorktreeGitOptions: worktreeGitOptions,
    localWorktreeGitOptionArgs: worktreeGitArgs,
    hostedReviewExecutionContext: args.hostedReviewExecutionContext
  })
  const git = await createRuntimeLocalGitWorktree({
    request,
    repo,
    store,
    settings,
    baseBranch,
    branchName: candidate.branchName,
    worktreePath: candidate.worktreePath,
    effectiveSanitizedName: candidate.effectiveSanitizedName,
    checkoutExistingBranch: candidate.checkoutExistingBranch,
    localWorktreeGitOptions: worktreeGitOptions,
    hasLocalWorktreeGitOptions: hasWorktreeGitOptions,
    localWorktreeGitOptionArgs: worktreeGitArgs,
    resolveRemoteTrackingBase: args.resolveRemoteTrackingBase,
    hasRemoteTrackingRef: args.hasRemoteTrackingRef,
    refreshRemoteTrackingBase: args.refreshRemoteTrackingBase,
    fetchRemote: args.fetchRemote
  })
  const materialized = await materializeRuntimeLocalWorktree({
    request,
    repo,
    store,
    settings,
    created: git.created,
    remoteTrackingBase: git.remoteTrackingBase,
    sparseDirectories: git.sparseDirectories,
    configuredPushTarget: git.configuredPushTarget,
    checkoutExistingBranch: candidate.checkoutExistingBranch,
    baseBranch,
    branchName: candidate.branchName,
    effectiveRequestedName: candidate.effectiveRequestedName,
    requestedDisplayName: candidate.requestedDisplayName,
    effectiveSanitizedName: candidate.effectiveSanitizedName,
    effectiveCreatedWithAgent: args.createdWithAgent,
    localWorktreeGitOptions: worktreeGitOptions
  })
  return {
    ...materialized,
    worktreePath: candidate.worktreePath,
    created: git.created,
    addResult: git.addResult
  }
}
