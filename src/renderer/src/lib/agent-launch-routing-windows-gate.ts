import type { AppState } from '@/store/types'
import { worktreeUsesWslPath } from '@/store/terminals/terminal-workspace-routing'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'

export type WindowsProcessStartTimeGate = 'available' | 'unavailable' | 'unknown'

/**
 * Derive the host half of the Windows structured gate once, so the routing call
 * sites cannot drift apart. A host that has never answered the probe is
 * 'unknown', which the router refuses — an unproved PID must never be adopted.
 */
export function readWindowsProcessStartTimeGate(ownerKey = 'local'): WindowsProcessStartTimeGate {
  if (!hasCachedWindowsTerminalCapabilities(ownerKey)) {
    return 'unknown'
  }
  return getCachedWindowsTerminalCapabilities(ownerKey).windowsProcessStartTimeAvailable === true
    ? 'available'
    : 'unavailable'
}

/** Workspace half, for a workspace that already exists in the store.
 *  Both collections are defaulted: a store that has not hydrated them yet must
 *  read as "not WSL", not throw on the launch path. */
export function readWorktreeUsesWslPath(
  state: Partial<Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>>,
  worktreeId: string
): boolean {
  return worktreeUsesWslPath(
    {
      folderWorkspaces: state.folderWorkspaces ?? [],
      worktreesByRepo: state.worktreesByRepo ?? {}
    },
    worktreeId
  )
}

/** Workspace half, for a creation flow whose workspace has no store entry yet. */
export function pathUsesWslUnc(path: string | null | undefined): boolean {
  return path ? isWslUncPath(path) : false
}

/** Both halves at once, so a store-backed call site adds one line, not two. */
export function readWindowsStructuredGateInputs(
  state: Partial<Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>>,
  worktreeId: string
): { windowsProcessStartTime: WindowsProcessStartTimeGate; worktreeUsesWslPath: boolean } {
  return {
    windowsProcessStartTime: readWindowsProcessStartTimeGate(),
    worktreeUsesWslPath: readWorktreeUsesWslPath(state, worktreeId)
  }
}
