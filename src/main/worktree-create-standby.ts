import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getBaseRefDefault } from './git/repo'
import { hasLocalWorktreeBaseRef } from './git/worktree-base-ref-probe'
import { getLocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { resolveWorktreeCreateBase } from './worktree-create-base'
import {
  prepareWorktreeCreateForRepo,
  retainWorktreeCreateForRepo
} from './worktree-create-preparation'

async function resolveStandbyBase(
  store: Store,
  repo: Repo,
  requestedBaseBranch?: string
): Promise<string | undefined> {
  if (getRepoExecutionHostId(repo) !== 'local' || isFolderRepo(repo)) {
    return
  }
  const options = getLocalProjectWorktreeGitOptions(store, repo)
  const baseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => getBaseRefDefault(repo.path, options),
    isBaseUsable: (base) => hasLocalWorktreeBaseRef(repo.path, base, options)
  })
  // Standby never fetches a missing base; the ordinary Create flow owns refresh and errors.
  if (!baseBranch || !(await hasLocalWorktreeBaseRef(repo.path, baseBranch, options))) {
    return
  }
  return baseBranch
}

export async function prepareWorktreeCreateStandby(
  store: Store,
  repo: Repo,
  requestedBaseBranch?: string
): Promise<void> {
  const base = await resolveStandbyBase(store, repo, requestedBaseBranch)
  if (base) {
    await prepareWorktreeCreateForRepo(store, repo, base)
  }
}

export async function retainWorktreeCreateStandby(
  store: Store,
  repo: Repo,
  requestedBaseBranch?: string
): Promise<() => void> {
  const base = await resolveStandbyBase(store, repo, requestedBaseBranch)
  return base ? retainWorktreeCreateForRepo(store, repo, base) : () => {}
}
