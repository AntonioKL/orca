import { ipcMain, type WebContents } from 'electron'
import { createWorktreeStandbyOwner } from '../../../worktree-create-standby-owner'
import {
  prepareWorktreeCreateStandby,
  retainWorktreeCreateStandby
} from '../../../worktree-create-standby'
import { prefetchWorktreeCreateBase } from '../../../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../../../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../../../project-runtime-git-options'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export function registerWorktreePrefetchHandler(context: WorktreeIpcContext): () => void {
  const { store, runtime } = context
  const owners = new Map<
    WebContents,
    { controller: ReturnType<typeof createWorktreeStandbyOwner>; dispose: () => void }
  >()
  ipcMain.handle(
    'worktrees:setCreateStandby',
    async (event, args: { repoId: string | null; baseBranch?: string }) => {
      const sender = event.sender
      if (sender.isDestroyed()) {
        return
      }
      let owner = owners.get(sender)
      if (!owner) {
        if (!args.repoId) {
          return
        }
        const controller = createWorktreeStandbyOwner()
        const dispose = () => {
          controller.close()
          owners.delete(sender)
          sender.removeListener('destroyed', dispose)
          sender.removeListener('render-process-gone', dispose)
          sender.removeListener('did-start-navigation', onNavigation)
        }
        const onNavigation = (
          _event: Electron.Event,
          _url: string,
          isInPlace: boolean,
          isMainFrame: boolean
        ): void => {
          if (isMainFrame && !isInPlace) {
            dispose()
          }
        }
        owner = { controller, dispose }
        owners.set(sender, owner)
        sender.once('destroyed', dispose)
        sender.once('render-process-gone', dispose)
        sender.on('did-start-navigation', onNavigation)
      }
      await owner.controller.set(
        args.repoId
          ? async (onConsumed) => {
              const repo = store.getRepo(args.repoId!)
              return repo
                ? retainWorktreeCreateStandby(store, repo, args.baseBranch, onConsumed)
                : () => {}
            }
          : undefined
      )
    }
  )

  ipcMain.handle(
    'worktrees:prepareCreateCheckout',
    async (_event, args: { repoId: string; baseBranch?: string }): Promise<void> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return
      }
      try {
        await prepareWorktreeCreateStandby(store, repo, args.baseBranch)
      } catch {
        // Speculative failure must not interrupt the active workspace.
      }
    }
  )

  ipcMain.handle(
    'worktrees:prefetchCreateBase',
    async (_event, args: { repoId: string; baseBranch?: string }): Promise<void> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return
      }
      try {
        await prefetchWorktreeCreateBase({
          repo,
          baseBranch: args.baseBranch,
          runtime,
          gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo),
          prepareLocalCheckout: (baseBranch) =>
            prepareWorktreeCreateForRepo(store, repo, baseBranch)
        })
      } catch {
        // Why: optimistic warm-up; the real create path awaits the same refresh and reports failures there.
      }
    }
  )
  return () => {
    for (const owner of owners.values()) {
      owner.dispose()
    }
  }
}
