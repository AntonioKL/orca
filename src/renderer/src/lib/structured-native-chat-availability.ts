import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { getCachedWindowsTerminalCapabilities } from './windows-terminal-capabilities'

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
  // Structured ownership on Windows is safe only when the local runtime has
  // already proved that its process table exposes creation times. Unknown is
  // deliberately treated as unavailable so a stale PID can never be adopted.
  if (
    getRendererAppPlatform() === 'win32' &&
    getCachedWindowsTerminalCapabilities('local').windowsProcessStartTimeAvailable !== true
  ) {
    return false
  }
  // Refuse WSL and repair-required runtimes; Windows native execution is
  // supported when the host advertises the process identity capability.
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return !(projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl')
}
