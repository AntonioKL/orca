import type { AppState } from '@/store/types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

export function canUseStructuredNativeChat(state: AppState, worktreeId: string): boolean {
  if (state.settings?.experimentalStructuredNativeChat !== true) {
    return false
  }
  if (getExecutionHostIdForWorktree(state, worktreeId) !== 'local') {
    return false
  }
  // The shipped Windows process-tree addon may not expose creation time. Until
  // the host advertises that proof, refuse every local Windows execution path —
  // windows-host, WSL, and keys that resolve no project runtime (folder
  // workspaces, floating terminal) — so create cannot fail after the click.
  return getRendererAppPlatform() !== 'win32'
}
