import type { AppState } from '@/store/types'
import { worktreeUsesWslPath } from '@/store/terminals/terminal-workspace-routing'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { isWebClientLocation } from '@/lib/web-client-location'
import { readLocalRuntimeHostPlatform } from '@/runtime/local-runtime-capabilities'

export type WindowsProcessStartTimeGate = 'available' | 'unavailable' | 'unknown'

/** The runtime owns the execution platform in paired web; an unknown host must fail closed. */
export function readAgentLaunchHostPlatform(
  clientPlatform: NodeJS.Platform
): NodeJS.Platform | null {
  return readLocalRuntimeHostPlatform() ?? (isWebClientLocation() ? null : clientPlatform)
}

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

/** All host-owned inputs for a workspace whose store entry does not exist yet. */
export function readWindowsCreationGateInputs(
  clientPlatform: NodeJS.Platform,
  workspacePath?: string | null
): {
  executionHostPlatform: NodeJS.Platform | null
  windowsProcessStartTime: WindowsProcessStartTimeGate
  worktreeUsesWslPath: boolean
} {
  return {
    executionHostPlatform: readAgentLaunchHostPlatform(clientPlatform),
    windowsProcessStartTime: readWindowsProcessStartTimeGate(),
    worktreeUsesWslPath: pathUsesWslUnc(workspacePath)
  }
}

/** All host-owned inputs for a workspace already present in the store. */
export function readWindowsStructuredGateInputs(
  state: Partial<Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>>,
  worktreeId: string,
  clientPlatform: NodeJS.Platform
): {
  executionHostPlatform: NodeJS.Platform | null
  windowsProcessStartTime: WindowsProcessStartTimeGate
  worktreeUsesWslPath: boolean
} {
  return {
    executionHostPlatform: readAgentLaunchHostPlatform(clientPlatform),
    windowsProcessStartTime: readWindowsProcessStartTimeGate(),
    worktreeUsesWslPath: readWorktreeUsesWslPath(state, worktreeId)
  }
}
