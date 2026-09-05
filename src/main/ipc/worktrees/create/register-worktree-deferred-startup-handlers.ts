import { ipcMain } from 'electron'
import { ptyOwnership } from '../../pty/provider/ownership-state'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeStartupReleaseArgs } from '../../../../shared/worktree/launch-types'
import { resolveWorktreeCreateRoute } from '../../../worktree-create-execution-host-route'
import { resolvePersistedStablePaneOwner } from '../../pty/pane/stable-owner'
import {
  supportsDeferredStartupFromRuntimeController,
  releaseStartupFromRuntimeController
} from '../../pty/runtime/deferred-startup'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export function isNativeDeferredStartupRepo(repo: Repo): boolean {
  return !isFolderRepo(repo) && resolveWorktreeCreateRoute(repo).kind === 'local'
}

export function registerWorktreeDeferredStartupHandlers(context: WorktreeIpcContext): void {
  ipcMain.handle('worktrees:supportsDeferredStartup', async (_event, repoId: string) => {
    const repo = context.store.getRepo(repoId)
    return Boolean(
      repo &&
      isNativeDeferredStartupRepo(repo) &&
      (await supportsDeferredStartupFromRuntimeController(null))
    )
  })
  ipcMain.handle('worktrees:releaseStartup', async (_event, args: WorktreeStartupReleaseArgs) => {
    if (ptyOwnership.get(args.ptyId) !== null) {
      return 'unavailable'
    }
    const session = context.store.getWorkspaceSession()
    for (const tab of session.tabsByWorktree?.[args.worktreeId] ?? []) {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (ptyId !== args.ptyId) {
          continue
        }
        const owner = resolvePersistedStablePaneOwner(
          context.store,
          makePaneKey(tab.id, leafId),
          args.worktreeId,
          null
        )
        if (!owner || owner.incarnationId !== args.expectedIncarnationId) {
          return 'identity-mismatch'
        }
        return releaseStartupFromRuntimeController(
          args.ptyId,
          args.expectedIncarnationId,
          args.operationId
        )
      }
    }
    return 'unavailable'
  })
}
