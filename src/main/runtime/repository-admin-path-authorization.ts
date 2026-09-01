import type { Store } from '../persistence'
import { resolveAuthorizedPath, type ResolveAuthorizedPathOptions } from '../ipc/filesystem-auth'
import {
  isRepositoryAdminPath,
  REPOSITORY_ADMIN_PATH_DENIED_MESSAGE
} from '../../shared/repository-admin-path'

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
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  const resolvedPath = await resolveAuthorizedPath(targetPath, store, options)
  if (isRepositoryAdminPath(resolvedPath, process.platform === 'win32' ? 'win32' : 'posix')) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
  return resolvedPath
}
