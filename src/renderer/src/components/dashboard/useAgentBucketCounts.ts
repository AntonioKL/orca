import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { buildDashboardBucketCounts } from './build-dashboard-bucket-counts'

export type AgentBucketCounts = Record<DashboardBucket, number>

type BucketCountInputs = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'folderWorkspaces'
  | 'acknowledgedAgentsByPaneKey'
  | 'agentStatusEpoch'
>

type BucketCountGate = BucketCountInputs & { counts: AgentBucketCounts }

// Why module scope rather than useShallow: Zustand re-runs this selector on
// every store write, and `shallow()` allocated a 14-key object plus two key
// arrays each time just to prove nothing moved. Comparing the same 14 slice
// identities in place allocates nothing on the unchanged path.
let gate: BucketCountGate | null = null

export function resetAgentBucketCountGateForTests(): void {
  gate = null
}

function bucketCountInputsUnchanged(s: AppState): boolean {
  return (
    gate !== null &&
    gate.repos === s.repos &&
    gate.worktreesByRepo === s.worktreesByRepo &&
    gate.tabsByWorktree === s.tabsByWorktree &&
    gate.unifiedTabsByWorktree === s.unifiedTabsByWorktree &&
    gate.agentStatusByPaneKey === s.agentStatusByPaneKey &&
    gate.retainedAgentsByPaneKey === s.retainedAgentsByPaneKey &&
    gate.migrationUnsupportedByPtyId === s.migrationUnsupportedByPtyId &&
    gate.runtimeAgentOrchestrationByPaneKey === s.runtimeAgentOrchestrationByPaneKey &&
    gate.terminalLayoutsByTabId === s.terminalLayoutsByTabId &&
    gate.ptyIdsByTabId === s.ptyIdsByTabId &&
    gate.runtimePaneTitlesByTabId === s.runtimePaneTitlesByTabId &&
    gate.folderWorkspaces === s.folderWorkspaces &&
    gate.acknowledgedAgentsByPaneKey === s.acknowledgedAgentsByPaneKey &&
    gate.agentStatusEpoch === s.agentStatusEpoch
  )
}

function countsEqual(previous: AgentBucketCounts, next: AgentBucketCounts): boolean {
  return (
    previous.attention === next.attention &&
    previous.working === next.working &&
    previous.done === next.done &&
    previous.idle === next.idle
  )
}

function selectAgentBucketCounts(s: AppState): AgentBucketCounts {
  if (gate !== null && bucketCountInputsUnchanged(s)) {
    return gate.counts
  }
  const next = buildDashboardBucketCounts(
    {
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      tabsByWorktree: s.tabsByWorktree,
      unifiedTabsByWorktree: s.unifiedTabsByWorktree,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      folderWorkspaces: s.folderWorkspaces,
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      // Same: counts never render a card's conversation name, so the
      // generated-title gate is moot and the sidebar stays off settings.
      settings: null
    },
    // Why: Date.now() is read only when an input slice moved, so idle-decay
    // tracks agentStatusEpoch ticks, matching useDashboardData.
    Date.now()
  )
  // Why: an agent ping that leaves every bucket total where it was must not
  // re-render the sidebar entry.
  const counts = gate !== null && countsEqual(gate.counts, next) ? gate.counts : next
  gate = {
    repos: s.repos,
    worktreesByRepo: s.worktreesByRepo,
    tabsByWorktree: s.tabsByWorktree,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    folderWorkspaces: s.folderWorkspaces,
    acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
    agentStatusEpoch: s.agentStatusEpoch,
    counts
  }
  return counts
}

/**
 * Per-state agent counts for the sidebar dashboard entry, using the same row
 * and bucket derivation as the pop-out board without allocating its cards.
 * Recomputes only when an input slice changes, and then only re-walks the
 * worktrees whose own inputs moved.
 */
export function useAgentBucketCounts(): AgentBucketCounts {
  return useAppStore(selectAgentBucketCounts)
}
