import { lstat, realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { resolveAuthorizedPath, type ResolveAuthorizedPathOptions } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  isRepositoryAdminPath,
  REPOSITORY_ADMIN_PATH_DENIED_MESSAGE,
  type RepositoryAdminPathFlavour
} from '../../shared/repository-admin-path'

/** The executing host's flavour, read off a path it owns rather than assumed from this process. */
export function repositoryPathFlavourForHost(hostPath: string): RepositoryAdminPathFlavour {
  return isWindowsAbsolutePathLike(hostPath) ? 'win32' : 'posix'
}

/** Refuses a host-absolute mutation target, taking the flavour from the path itself. */
export function assertMutableHostPath(hostPath: string): void {
  if (isRepositoryAdminPath(hostPath, repositoryPathFlavourForHost(hostPath))) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

/**
 * Refuses a worktree-relative mutation target before the local/SSH split.
 *
 * This is the SSH lane's only cover: that branch returns before any path is resolved, so the
 * relative spelling is all there is to classify there.
 */
export function assertMutableRuntimeRelativePath(relativePath: string, worktreePath: string): void {
  if (isRepositoryAdminPath(relativePath, repositoryPathFlavourForHost(worktreePath))) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

export const REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE =
  'Access denied: this file has more than one name on disk, so writing through it could modify Git repository metadata.'

export type ResolveAuthorizedMutablePathOptions = ResolveAuthorizedPathOptions & {
  /**
   * The syscall acts on the OBJECT a name points at rather than on the directory entry — copy reads
   * and writes through it, `writeFile` truncates through it. Rename and delete act on the entry, so
   * they leave this off. Set it to classify the link target and refuse multi-named inodes.
   */
  followsLink?: boolean
}

/**
 * Authorizes a file-explorer mutation, then refuses repository admin state on the path the
 * filesystem will actually touch.
 *
 * The caller's relative spelling is not enough on its own: a symlinked ancestor (`foo -> .git`)
 * carries no `.git` segment, yet `resolveAuthorizedPath` canonicalizes it — including through the
 * nearest existing ancestor of a not-yet-created path — straight into `.git`.
 *
 * Fails closed: `resolveAuthorizedPath` throws when it cannot canonicalize, so an unclassifiable
 * path never reaches the check.
 */
export async function resolveAuthorizedMutablePath(
  targetPath: string,
  store: Store,
  options: ResolveAuthorizedMutablePathOptions = {}
): Promise<string> {
  const { followsLink, ...authorizationOptions } = options
  const resolvedPath = await resolveAuthorizedPath(targetPath, store, authorizationOptions)
  assertMutablePath(resolvedPath)
  if (followsLink) {
    assertMutablePath(await canonicalLeaf(resolvedPath))
    await assertNotHardLinked(resolvedPath)
  }
  return resolvedPath
}

/**
 * Refuses a file that has more than one name on disk.
 *
 * A hard link into `.git` cannot be detected by path: every name for the inode is equally real and
 * `realpath` returns the one it was given. Link count is the only portable signal that another name
 * — possibly inside `.git` — reaches the same bytes. Mirrors the existing `nlink > 1` refusal on
 * terminal artifacts.
 *
 * Partial by nature: `nlink` is not dependable on Windows, so this closes the POSIX case only.
 */
async function assertNotHardLinked(path: string): Promise<void> {
  let linkCount: number
  try {
    linkCount = (await lstat(path)).nlink
  } catch (error) {
    // Nothing on disk yet has no aliases. Any other stat failure aborts the mutation on its own
    // error, which the following syscall would raise anyway, so it is not restated as a refusal.
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  if (linkCount > 1) {
    throw new Error(REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE)
  }
}

function assertMutablePath(path: string): void {
  if (isRepositoryAdminPath(path, process.platform === 'win32' ? 'win32' : 'posix')) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

async function canonicalLeaf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    // A path that does not exist yet has no link to follow; the caller creates a real file there.
    if (isENOENT(error)) {
      return path
    }
    // Fail closed: the leaf exists but cannot be canonicalized, so what it points at is unknown.
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}
