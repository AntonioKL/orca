import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { gitExecFileAsync } from '../git/runner'
import { isENOENT } from '../ipc/filesystem-auth'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWorktreePathMissing } from '../worktree-removal-safety'
import {
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'
import type { RuntimeStore } from './runtime-store-contract'
import { gitStatusErrorMeansNotRepository } from './runtime-worktree-selection'

export async function isRuntimeWorktreePathMissing(
  repo: Repo,
  worktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  if (!repo.connectionId) {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    return isWorktreePathMissing(
      toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
      access.statPath
    )
  }
  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  return fsProvider ? isWorktreePathMissing(worktreePath, (path) => fsProvider.stat(path)) : false
}

export async function isLocalRuntimeGitRepository(
  runtimeWorktreePath: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  try {
    await gitExecFileAsync(['status', '--short'], {
      cwd: runtimeWorktreePath,
      ...localWorktreeGitOptions
    })
    return true
  } catch (error) {
    return !gitStatusErrorMeansNotRepository(error)
  }
}

function getRuntimeFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getRuntimeFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

export function listRuntimeFolderWorkspaces(
  store: Pick<RuntimeStore, 'getAllWorktreeMeta' | 'setWorktreeMeta'>,
  repo: Repo
): Worktree[] {
  const rootId = getRuntimeFolderWorkspaceRootId(repo)
  const allMeta = store.getAllWorktreeMeta()
  const ids = Object.keys(allMeta).filter((worktreeId) =>
    isRuntimeFolderWorkspaceIdForRepo(repo, worktreeId)
  )
  if (!ids.includes(rootId)) {
    ids.unshift(rootId)
  } else {
    ids.sort((left, right) => (left === rootId ? -1 : right === rootId ? 1 : 0))
  }
  return ids.map((worktreeId) => {
    const existing = allMeta[worktreeId]
    const meta = existing?.instanceId
      ? existing
      : store.setWorktreeMeta(worktreeId, {
          instanceId: getRuntimeFolderWorkspaceInstanceIdentity(repo, worktreeId),
          ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
        })
    return mergeRuntimeFolderWorkspace(repo, worktreeId, meta)
  })
}

export async function runtimePathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}
