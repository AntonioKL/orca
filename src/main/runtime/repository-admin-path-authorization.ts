import { realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
import { resolveAuthorizedPath, type ResolveAuthorizedPathOptions } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  isRepositoryAdminPath,
  REPOSITORY_ADMIN_PATH_DENIED_MESSAGE
} from '../../shared/repository-admin-path'

export type ResolveAuthorizedMutablePathOptions = ResolveAuthorizedPathOptions & {
  /**
   * The syscall reads or writes *through* a leaf symlink (copy does; rename and delete act on the
   * directory entry instead). Set it so the link's target is classified as well.
   */
  followsLeafSymlink?: boolean
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
  const { followsLeafSymlink, ...authorizationOptions } = options
  const resolvedPath = await resolveAuthorizedPath(targetPath, store, authorizationOptions)
  assertMutablePath(resolvedPath)
  if (followsLeafSymlink) {
    assertMutablePath(await canonicalLeaf(resolvedPath))
  }
  return resolvedPath
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
