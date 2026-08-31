import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

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
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  if (executionHostId !== 'local') {
    // Runtime-owned worktrees may use the paired structured host when its
    // negotiated status is already known. SSH ownership deliberately remains
    // on the legacy terminal bridge: it has no agent-session RPC transport.
    if (!executionHostId.startsWith('runtime:')) {
      return false
    }
    const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    const status = environmentId
      ? state.runtimeStatusByEnvironmentId?.get(environmentId)?.status
      : undefined
    return status?.capabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  }
  // Refuse WSL and repair-required runtimes; Windows native execution is
  // supported when the host advertises the process identity capability.
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return !(projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl')
}
