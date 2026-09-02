import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { entryWithRuntimeOrchestration } from '../sidebar/worktree-agent-row-orchestration'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentStatusState
} from '../../../../shared/agent-status-types'
import {
  collectChildAgentPaneKeys,
  type ChildAgentClassifiableThread
} from './activity-thread-child-agent'

type ActivityUnreadCountSource = Pick<
  AppState,
  | 'acknowledgedAgentsByPaneKey'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
> & {
  /** Per-pane "Clear completed" cutoffs; hidden events must not count as unread. */
  activityClearedAtByPaneKey?: Record<string, number>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  /** Mirrors the Agents list's child filter: children of listed parents are
   *  excluded from sidebar-badge counts unless the user shows child agents. */
  showChildAgents?: boolean
}

type ActivityUnreadCountMode = 'agent-events' | 'sidebar-badge'

const EMPTY_MIGRATION_UNSUPPORTED: AppState['migrationUnsupportedByPtyId'] = {}
const EMPTY_RETAINED_AGENTS: AppState['retainedAgentsByPaneKey'] = {}
const EMPTY_ACKNOWLEDGED_AGENTS: AppState['acknowledgedAgentsByPaneKey'] = {}
const EMPTY_ACTIVITY_CLEARED_AT: Record<string, number> = {}
const EMPTY_RUNTIME_ORCHESTRATION: Record<string, AgentStatusOrchestrationContext> = {}

const DISABLED_ACTIVITY_UNREAD_INPUTS = {
  sortEpoch: 0,
  migrationUnsupportedByPtyId: EMPTY_MIGRATION_UNSUPPORTED,
  retainedAgentsByPaneKey: EMPTY_RETAINED_AGENTS,
  acknowledgedAgentsByPaneKey: EMPTY_ACKNOWLEDGED_AGENTS,
  activityClearedAtByPaneKey: EMPTY_ACTIVITY_CLEARED_AT,
  runtimeAgentOrchestrationByPaneKey: EMPTY_RUNTIME_ORCHESTRATION,
  showChildAgents: false
}

function isUnreadAgentState(state: AgentStatusState): boolean {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}

/** Minimal rows stand in for threads so the always-mounted badge never runs the
 *  full thread-building pipeline. */
function toChildClassifierRow(entry: AgentStatusEntry): ChildAgentClassifiableThread {
  return {
    paneKey: entry.paneKey,
    currentAgentEntry: entry
  }
}

function collectHiddenChildPaneKeys(source: ActivityUnreadCountSource): ReadonlySet<string> {
  const rows: ChildAgentClassifiableThread[] = []
  const seenPaneKeys = new Set<string>()
  const push = (entry: AgentStatusEntry | null): void => {
    if (!entry || seenPaneKeys.has(entry.paneKey)) {
      return
    }
    seenPaneKeys.add(entry.paneKey)
    rows.push(
      toChildClassifierRow(
        entryWithRuntimeOrchestration(entry, source.runtimeAgentOrchestrationByPaneKey)
      )
    )
  }
  for (const entry of Object.values(source.agentStatusByPaneKey)) {
    push(entry)
  }
  for (const retained of Object.values(source.retainedAgentsByPaneKey)) {
    push(retained.entry)
  }
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    push(migrationUnsupportedToAgentStatusEntry(unsupported))
  }
  return collectChildAgentPaneKeys(rows)
}

export function countActivityUnread(
  source: ActivityUnreadCountSource,
  mode: ActivityUnreadCountMode
): number {
  let count = 0

  // Why no worktree.isUnread here: the Agents tab lists only agent threads, so a
  // worktree unread would light a badge with no row to read and no way to clear it.
  // Why the child exclusion: the badge counts exactly what Mark all read can clear;
  // a child hidden by the default filter must not keep the badge lit forever.
  const hiddenChildPaneKeys =
    mode === 'sidebar-badge' && source.showChildAgents !== true
      ? collectHiddenChildPaneKeys(source)
      : null

  const countEntry = (entry: AgentStatusEntry, ackAt: number): void => {
    // Why: "Clear completed" hides events at or before the pane's cutoff from the feed,
    // so a hidden event must not keep the badge lit; treat the cutoff like an ack floor.
    const clearedAt = source.activityClearedAtByPaneKey?.[entry.paneKey] ?? 0
    const mutedAt = Math.max(ackAt, clearedAt)
    if (mode === 'agent-events') {
      // Why: Activity feed surfaces historical done/blocked/waiting events
      // from stateHistory, so the titlebar badge must mirror that event count.
      for (const history of entry.stateHistory) {
        if (isUnreadAgentState(history.state) && mutedAt < history.startedAt) {
          count += 1
        }
      }
    }
    // Why: a session-boundary done is an idle connect (STA-3386), not an event to read.
    // History never contains a boundary, but it DOES keep the real completion a boundary
    // displaced (the slice pushes it on done→done), so sidebar-badge mode — which skips the
    // history loop above — must still count that displaced completion or the badge silently
    // drops an unacknowledged finish the moment its session is resumed.
    if (
      isUnreadAgentState(entry.state) &&
      entry.sessionBoundary !== true &&
      mutedAt < entry.stateStartedAt
    ) {
      count += 1
    } else if (mode === 'sidebar-badge' && entry.state === 'done' && entry.sessionBoundary) {
      const displaced = entry.stateHistory.at(-1)
      if (displaced && isUnreadAgentState(displaced.state) && mutedAt < displaced.startedAt) {
        count += 1
      }
    }
  }

  for (const [paneKey, entry] of Object.entries(source.agentStatusByPaneKey)) {
    if (hiddenChildPaneKeys?.has(paneKey)) {
      continue
    }
    countEntry(entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  }
  for (const [paneKey, retained] of Object.entries(source.retainedAgentsByPaneKey)) {
    if (mode === 'sidebar-badge' && retained.entry.state !== 'done') {
      continue
    }
    if (hiddenChildPaneKeys?.has(paneKey)) {
      continue
    }
    countEntry(retained.entry, source.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  }
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
    if (entry && !hiddenChildPaneKeys?.has(entry.paneKey)) {
      countEntry(entry, source.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0)
    }
  }

  return count
}

export function useActivityUnreadCount(enabled: boolean, mode: ActivityUnreadCountMode): number {
  const {
    sortEpoch,
    migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey,
    acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey,
    runtimeAgentOrchestrationByPaneKey,
    showChildAgents
  } = useAppStore(
    useShallow((state) => {
      if (!enabled) {
        return DISABLED_ACTIVITY_UNREAD_INPUTS
      }
      return {
        // Why: live status prompt/tool updates churn agentStatusByPaneKey but
        // cannot change unread count unless a sort-relevant state transition
        // or removal occurred. sortEpoch is the cheap invalidation signal.
        sortEpoch: state.sortEpoch,
        migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
        acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
        runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
        showChildAgents: state.agentsShowChildAgents
      }
    })
  )

  return useMemo(() => {
    if (!enabled) {
      return 0
    }
    void sortEpoch
    return countActivityUnread(
      {
        agentStatusByPaneKey: useAppStore.getState().agentStatusByPaneKey,
        migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey,
        acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey,
        runtimeAgentOrchestrationByPaneKey,
        showChildAgents
      },
      mode
    )
  }, [
    acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey,
    enabled,
    migrationUnsupportedByPtyId,
    mode,
    retainedAgentsByPaneKey,
    runtimeAgentOrchestrationByPaneKey,
    showChildAgents,
    sortEpoch
  ])
}
