import { useMemo, useRef } from 'react'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '../store'
import { useAllWorktrees } from '../store/selectors'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { selectPairedRuntimeParkingEnvironmentIds } from './terminal-pane/terminal-hidden-view-parking'
import { isMainTerminalSideEffectAuthorityForPty } from './terminal-pane/terminal-side-effect-facts-handler'

export function useTerminalWorkspaceFoundation() {
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  const browserGuestWorktreeRecencyRef = useRef<string[]>([])
  const measurableBackgroundWorktreeIdsRef = useRef(new Set<string>())
  const terminalWorktreeHiddenSinceRef = useRef(new Map<string, number>())
  const measuringTerminalWorktreeIdsRef = useRef(new Set<string>())
  const terminalWorktreeParkCooldownUntilRef = useRef(new Map<string, number>())
  const terminalWorktreeParkingTimersRef = useRef(new Map<string, number>())
  const allWorktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const workspaceSurfaces = useMemo(
    () => [
      ...allWorktrees.map((worktree) => ({ id: worktree.id, path: worktree.path })),
      ...folderWorkspaces.map((workspace) => ({
        id: folderWorkspaceKey(workspace.id),
        path: workspace.folderPath
      }))
    ],
    [allWorktrees, folderWorkspaces]
  )
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const renderedActiveWorktreeId = activeWorktreeId
  const activeWorktreeDeferralHostId = useAppStore((state) =>
    getResolvedExecutionHostIdForWorktree(state, renderedActiveWorktreeId)
  )
  const activeView = useAppStore((state) => state.activeView)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const pendingStartupByTabId = useAppStore((state) => state.pendingStartupByTabId)
  const terminalParkingEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenViewParking !== false
  )
  const terminalSshParkingEnabled = useAppStore(
    (state) => state.settings?.terminalSshViewParking !== false
  )
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const pairedRuntimeParkingEnvironmentIds = useMemo(
    () => selectPairedRuntimeParkingEnvironmentIds(runtimeStatusByEnvironmentId),
    [runtimeStatusByEnvironmentId]
  )
  const terminalRetentionBudgetEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenWorktreeRetentionBudget !== false
  )
  const browserGuestRetentionBudgetEnabled = useAppStore(
    (state) => state.settings?.browserGuestWorktreeRetentionBudget !== false
  )
  const terminalTitleSnapshotAuthorityEnabled = useAppStore((state) =>
    isMainTerminalSideEffectAuthorityForPty({
      settings: state.settings,
      runtimeEnvironmentId: null
    })
  )

  return {
    mountedWorktreeIdsRef,
    browserGuestWorktreeRecencyRef,
    measurableBackgroundWorktreeIdsRef,
    terminalWorktreeHiddenSinceRef,
    measuringTerminalWorktreeIdsRef,
    terminalWorktreeParkCooldownUntilRef,
    terminalWorktreeParkingTimersRef,
    allWorktrees,
    folderWorkspaces,
    workspaceSurfaces,
    activeWorktreeId,
    renderedActiveWorktreeId,
    activeWorktreeDeferralHostId,
    activeView,
    tabsByWorktree,
    pendingStartupByTabId,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    runtimeStatusByEnvironmentId,
    pairedRuntimeParkingEnvironmentIds,
    terminalRetentionBudgetEnabled,
    browserGuestRetentionBudgetEnabled,
    terminalTitleSnapshotAuthorityEnabled
  }
}

export type TerminalWorkspaceFoundation = ReturnType<typeof useTerminalWorkspaceFoundation>
