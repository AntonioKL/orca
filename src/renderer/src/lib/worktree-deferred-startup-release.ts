import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { StartupCommandReleaseResult } from '../../../shared/deferred-startup-release'

export async function releasePreparedWorktreeStartup(
  creationId: string,
  result: CreateWorktreeResult
): Promise<boolean> {
  const terminal = result.startupTerminal
  const deferred = terminal?.deferredStartup
  if (!deferred) {
    return true
  }
  const state = useAppStore.getState()
  if (!state.pendingWorktreeCreations[creationId]) {
    return false
  }
  state.updatePendingWorktreeCreation(creationId, { deferredStartupRecovery: result })
  let release: StartupCommandReleaseResult = 'unavailable'
  try {
    if (terminal.ptyId && deferred.incarnationId && window.api?.worktrees?.releaseStartup) {
      release = await window.api.worktrees.releaseStartup({
        worktreeId: result.worktree.id,
        ptyId: terminal.ptyId,
        expectedIncarnationId: deferred.incarnationId,
        operationId: deferred.operationId
      })
    }
  } catch {
    release = 'unverifiable'
  }
  const current = useAppStore.getState()
  if (!current.pendingWorktreeCreations[creationId]) {
    return false
  }
  if (release === 'accepted') {
    return true
  }
  current.updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error:
      !terminal.ptyId || !deferred.incarnationId
        ? translate(
            'workspace.create.preparedTerminalUnverified',
            'Could not verify the prepared terminal. Your workspace is saved; open it to continue.'
          )
        : release === 'retired' || release === 'identity-mismatch'
          ? translate(
              'workspace.create.preparedTerminalChanged',
              'This terminal has changed. Your workspace is saved; open it to continue.'
            )
          : translate(
              'workspace.create.preparedAgentUnconfirmed',
              'Could not confirm the agent started. Your workspace is saved. Retry to check again.'
            )
  })
  return false
}
