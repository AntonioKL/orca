import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { getBaseRefDefault } from './git/repo'
import { hasLocalWorktreeBaseRef } from './git/worktree-base-ref-probe'
import { getLocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { resolveWorktreeCreateBase } from './worktree-create-base'
import { prepareWorktreeCreateForRepo } from './worktree-create-preparation'

export async function prepareWorktreeCreateStandby(
  store: Store,
  repo: Repo,
  requestedBaseBranch?: string
): Promise<void> {
  if (repo.connectionId || isFolderRepo(repo)) {
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
  await prepareWorktreeCreateForRepo(store, repo, baseBranch)
}
