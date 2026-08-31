import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export function canUseStructuredNativeChat(state: AppState, worktreeId: string): boolean {
  if (state.settings?.experimentalStructuredNativeChat !== true) {
    return false
  }
  // Structured chat has no entry path of its own — it reuses the Chat UI default view. With
  // Terminal chat selected the toggle is hidden but its persisted value survives, so gate on the
  // default view too or a stale `true` would silently route new tabs into the structured runtime.
  if (state.settings?.openAgentTabsInChatByDefault !== true) {
    return false
  }
  if (getExecutionHostIdForWorktree(state, worktreeId) !== 'local') {
    return false
  }
  // Refuse WSL and repair-required runtimes; Windows native execution is
  // supported when the host advertises the process identity capability.
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return !(projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl')
}
