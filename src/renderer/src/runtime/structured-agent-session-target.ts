import type { AppState } from '../store/types'
import { getRuntimeEnvironmentIdForWorktree } from '../lib/worktree-runtime-owner'
import type { RuntimeClientTarget } from './runtime-client-target'

/** Resolve the execution host that owns a structured session for a worktree. */
export function getStructuredAgentSessionTarget(
  state: AppState,
  worktreeId: string
): RuntimeClientTarget {
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}
