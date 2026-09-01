import { useDeferredValue, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import { buildActivityEvents, createActivityEventBuildCache } from './activity-event-builder'
import { buildAgentPaneThreads, createAgentPaneThreadReuseCache } from './activity-thread-builder'
import { isChildAgentThread } from './activity-thread-child-agent'
import {
  resolveActivityScopeRepoIds,
  threadMatchesActivityScope,
  type ActivityScopeFilter
} from './activity-scope-filter'
import {
  activityThreadMatchesSearchQuery,
  buildActivityThreadGroups,
  isActivitySearchQueryTooLarge
} from './activity-thread-grouping'
import type {
  ActivityGroupBy,
  ActivityThreadGroup,
  AgentPaneThread,
  ThreadReadFilter
} from './activity-thread-types'

export type AgentPaneThreadsStoreData = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'acknowledgeAgents'
  | 'unacknowledgeAgents'
> & {
  worktreeMap: ReturnType<typeof getWorktreeMapFromState>
  repoMap: ReturnType<typeof getRepoMapFromState>
  generatedTitlesEnabled: boolean
}

/** The Activity thread pipeline (store read -> events -> threads -> filter ->
 *  groups), shared by the Activity page and the sidebar agents list. */
export function useAgentPaneThreads(args: {
  query: string
  readFilter: ThreadReadFilter
  groupBy: ActivityGroupBy
  selectedPaneKey: string | null
  showChildAgents?: boolean
}): {
  storeData: AgentPaneThreadsStoreData
  allThreads: AgentPaneThread[]
  selectedPaneKeyIsLive: boolean
  effectiveSelectedPaneKey: string | null
  visibleThreads: AgentPaneThread[]
  visibleThreadGroups: ActivityThreadGroup[]
  /** Threads excluded by the persisted host/project scope — the chips row shows this so scope filtering is never silent. */
  scopeHiddenThreadCount: number
} {
  const { query, readFilter, groupBy, selectedPaneKey, showChildAgents = false } = args
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const defaultHostId = useAppStore((s) => getSettingsFocusedExecutionHostId(s.settings))
  const storeData = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      worktreeMap: getWorktreeMapFromState(s),
      repoMap: getRepoMapFromState(s),
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      activityClearedAtByPaneKey: s.activityClearedAtByPaneKey,
      acknowledgeAgents: s.acknowledgeAgents,
      unacknowledgeAgents: s.unacknowledgeAgents,
      generatedTitlesEnabled: s.settings?.tabAutoGenerateTitle === true
    }))
  )
  // Why: agentStatusEpoch is a dep (not used in the body) so the memo recomputes when freshness boundaries expire even without new PTY data.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  // Why per-hook caches: unchanged panes keep their exact event/snapshot/thread object
  // identities across rebuilds, so a status write to one agent leaves every other row's
  // memo bail-out and cached search text intact. Rebuilds are deterministic, so a repeated
  // (StrictMode/deferred) memo invocation returns identical objects from the cache.
  const eventBuildCacheRef = useRef(createActivityEventBuildCache())
  const threadReuseCacheRef = useRef(createAgentPaneThreadReuseCache())

  const { events: allEvents, liveAgentByPaneKey } = useMemo(
    () =>
      buildActivityEvents(
        {
          agentStatusByPaneKey: storeData.agentStatusByPaneKey,
          runtimeAgentOrchestrationByPaneKey: storeData.runtimeAgentOrchestrationByPaneKey,
          migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
          retainedAgentsByPaneKey: storeData.retainedAgentsByPaneKey,
          tabsByWorktree: storeData.tabsByWorktree,
          worktreeMap: storeData.worktreeMap,
          repoMap: storeData.repoMap,
          acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
          activityClearedAtByPaneKey: storeData.activityClearedAtByPaneKey,
          // Why: Date.now() is read in the memo body (not a dep) so stale-decay recomputes when agentStatusEpoch ticks, not on wall-clock time.
          now: Date.now()
        },
        eventBuildCacheRef.current
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeData, agentStatusEpoch]
  )

  const allThreads = useMemo(
    () =>
      buildAgentPaneThreads(
        {
          events: allEvents,
          liveAgentByPaneKey,
          generatedTitlesEnabled: storeData.generatedTitlesEnabled
        },
        threadReuseCacheRef.current
      ),
    [allEvents, liveAgentByPaneKey, storeData.generatedTitlesEnabled]
  )

  const selectedPaneKeyIsLive =
    selectedPaneKey === null || allThreads.some((thread) => thread.paneKey === selectedPaneKey)
  const effectiveSelectedPaneKey = selectedPaneKeyIsLive ? selectedPaneKey : null

  // Why scope runs before the per-view filters: its hidden count must mean "hidden by
  // the persisted host/project scope alone", not folded into unread/search misses.
  const { scopedThreads, scopeHiddenThreadCount } = useMemo(() => {
    const scope: ActivityScopeFilter = {
      visibleHostIds: agentsVisibleHostIds,
      filterRepoIds: resolveActivityScopeRepoIds(agentsFilterRepoIds, storeData.repoMap),
      defaultHostId
    }
    const scoped = allThreads.filter(
      (thread) =>
        threadMatchesActivityScope(thread, scope) ||
        // Why: keep the just-selected thread visible so changing scope can't vanish the open row.
        thread.paneKey === effectiveSelectedPaneKey
    )
    return { scopedThreads: scoped, scopeHiddenThreadCount: allThreads.length - scoped.length }
  }, [
    allThreads,
    agentsVisibleHostIds,
    agentsFilterRepoIds,
    storeData.repoMap,
    defaultHostId,
    effectiveSelectedPaneKey
  ])

  // Why deferred: filtering hundreds of threads is interruptible background work; the input
  // echoes the keystroke at full priority while the list catches up on the deferred value.
  const deferredQuery = useDeferredValue(query)
  const visibleThreads = useMemo(() => {
    const normalizedQuery = isActivitySearchQueryTooLarge(deferredQuery)
      ? null
      : deferredQuery.trim().toLowerCase()
    return scopedThreads.filter((thread) => {
      // Why: keep the just-selected thread visible after auto-mark-read flips it to read, else unread-only mode makes the clicked row vanish from the list.
      if (
        readFilter === 'unread' &&
        !thread.unread &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      // Why: child agents (e.g. dispatched orchestration workers) are hidden by default to keep top-level agent views focused on root tasks.
      if (
        !showChildAgents &&
        isChildAgentThread(thread) &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      if (normalizedQuery === null) {
        return false
      }
      return activityThreadMatchesSearchQuery({ thread, searchQuery: normalizedQuery })
    })
  }, [scopedThreads, readFilter, deferredQuery, effectiveSelectedPaneKey, showChildAgents])

  const visibleThreadGroups = useMemo(
    () => buildActivityThreadGroups(visibleThreads, groupBy),
    [visibleThreads, groupBy]
  )

  return {
    storeData,
    allThreads,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    visibleThreadGroups,
    scopeHiddenThreadCount
  }
}
