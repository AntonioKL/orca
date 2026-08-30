import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { buildDashboardBucketCounts } from './build-dashboard-bucket-counts'

export type AgentBucketCounts = Record<DashboardBucket, number>

/**
 * Per-state agent counts for the sidebar dashboard entry, derived from the same
 * builder that feeds the pop-out board so the numbers always agree. Recomputes
 * only when an input slice changes (mirrors useDashboardData's cost profile).
 */
export function useAgentBucketCounts(): AgentBucketCounts {
  const {
    repos,
    worktreesByRepo,
    tabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    folderWorkspaces,
    acknowledgedAgentsByPaneKey,
    agentStatusEpoch
  } = useAppStore(
    useShallow((s) => ({
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      tabsByWorktree: s.tabsByWorktree,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      folderWorkspaces: s.folderWorkspaces,
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch
    }))
  )

  return useMemo(() => {
    return buildDashboardBucketCounts(
      {
        repos,
        worktreesByRepo,
        tabsByWorktree,
        agentStatusByPaneKey,
        retainedAgentsByPaneKey,
        migrationUnsupportedByPtyId,
        runtimeAgentOrchestrationByPaneKey,
        terminalLayoutsByTabId,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId,
        folderWorkspaces,
        acknowledgedAgentsByPaneKey,
        // Same: counts never render a card's conversation name, so the
        // generated-title gate is moot and the sidebar stays off settings.
        settings: null
      },
      Date.now()
    )
    // Why: Date.now() is read inside the memo (not a dep) so idle-decay tracks
    // agentStatusEpoch ticks, matching useDashboardData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    repos,
    worktreesByRepo,
    tabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    folderWorkspaces,
    acknowledgedAgentsByPaneKey,
    agentStatusEpoch
  ])
}
