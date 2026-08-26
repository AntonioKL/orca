import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

export function canUseStructuredNativeChat(state: AppState, worktreeId: string): boolean {
  if (state.settings?.experimentalStructuredNativeChat !== true) {
    return false
  }
  if (getExecutionHostIdForWorktree(state, worktreeId) !== 'local') {
    return false
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return !(
    projectRuntime?.status === 'repair-required' ||
    projectRuntime?.runtime.kind === 'wsl' ||
    // The shipped Windows process-tree addon may not expose creation time. Until
    // the host advertises that proof, keep this experimental surface on the
    // ordinary terminal path instead of letting create fail after the click.
    (getRendererAppPlatform() === 'win32' && projectRuntime?.runtime.kind === 'windows-host')
  )
}
