import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { findIndexedRepoOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type AgentStatusState,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  ActivityEvent,
  ActivityHookLiveAgentState,
  ActivityLiveAgentSnapshot,
  ActivityLiveAgentState
} from './activity-thread-types'
import { capActivityEvents } from './activity-event-cap'
import { newestActivityHistoryEntries } from './activity-pane-events'
import {
  createActivityEventBuildCache,
  resolvePaneBuild,
  type ActivityEventBuildCache
} from './activity-event-build-cache'
import { standaloneActivityWorktree } from './activity-standalone-worktree'
import { appendUnsupportedAndRetainedEvents } from './activity-event-builder-sources'

export { createActivityEventBuildCache, type ActivityEventBuildCache, newestActivityHistoryEntries }

function isActivityHookLiveAgentState(
  state: AgentStatusState
): state is ActivityHookLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  if (
    !isActivityHookLiveAgentState(entry.state) ||
    !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
  ) {
    return null
  }
  return entry.state === 'working' && entry.workingMode === 'monitoring'
    ? 'monitoring'
    : entry.state
}

export type BuildActivityEventsArgs = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree?: Record<string, Tab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  repos?: readonly Repo[]
  resolveWorktree?: (worktreeId: string, executionHostId?: ExecutionHostId) => Worktree | undefined
  acknowledgedAgentsByPaneKey: Record<string, number>
  /** Per-pane "Clear completed" cutoffs; events stamped at or before the cutoff are hidden. */
  activityClearedAtByPaneKey?: Record<string, number>
  now: number
}

type ActivityTabContext = { worktreeId: string; tab: TerminalTab }
type ActivityEventOwner = { worktree: Worktree; repo: Repo | null; knownWorktree: boolean }
type ActivityTabHostIndex = Map<string, Map<string, ExecutionHostId | null>>

function buildActivityTabHostIndex(args: BuildActivityEventsArgs): ActivityTabHostIndex {
  const index: ActivityTabHostIndex = new Map()
  for (const [worktreeId, tabs] of Object.entries(args.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType !== 'terminal' || !tab.executionHostId) {
        continue
      }
      let byTabId = index.get(worktreeId)
      if (!byTabId) {
        byTabId = new Map()
        index.set(worktreeId, byTabId)
      }
      const existing = byTabId.get(tab.entityId)
      byTabId.set(
        tab.entityId,
        existing === undefined || existing === tab.executionHostId ? tab.executionHostId : null
      )
    }
  }
  return index
}

function resolveActivityExecutionHostId(
  context: ActivityTabContext,
  entry: AgentStatusEntry,
  terminalPtyId: string | null | undefined,
  tabHostIndex: ActivityTabHostIndex
): ExecutionHostId | undefined {
  const tabHostId = tabHostIndex.get(context.worktreeId)?.get(context.tab.id)
  if (tabHostId) {
    return tabHostId
  }
  // Why before connectionId: a runtime pane's status entry publishes connectionId: null,
  // which would otherwise resolve to LOCAL (see dashboard-card-terminal-input's precedent).
  const runtimeEnvironmentId = getRemoteRuntimePtyEnvironmentId(terminalPtyId ?? '')
  if (runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(runtimeEnvironmentId)
  }
  if (entry.connectionId !== undefined) {
    return entry.connectionId ? toSshExecutionHostId(entry.connectionId) : LOCAL_EXECUTION_HOST_ID
  }
  const connectionId = parseAppSshPtyId(terminalPtyId ?? '')?.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : undefined
}

function resolveActivityEventOwner(
  args: BuildActivityEventsArgs,
  context: ActivityTabContext,
  entry: AgentStatusEntry,
  terminalPtyId: string | null | undefined,
  tabHostIndex: ActivityTabHostIndex,
  ownerCache: Map<string, ActivityEventOwner>
): ActivityEventOwner {
  const executionHostId = resolveActivityExecutionHostId(
    context,
    entry,
    terminalPtyId,
    tabHostIndex
  )
  // Why: resolution runs per pane per rebuild and the miss path scans detected worktrees;
  // everything below depends only on worktreeId + host, so memoize per build.
  const ownerCacheKey = `${context.worktreeId}\0${executionHostId ?? ''}`
  const cached = ownerCache.get(ownerCacheKey)
  if (cached) {
    return cached
  }
  const resolvedWorktree = args.resolveWorktree?.(context.worktreeId, executionHostId)
  const mappedWorktree = args.worktreeMap.get(context.worktreeId)
  const worktree =
    resolvedWorktree ??
    mappedWorktree ??
    standaloneActivityWorktree(context.worktreeId, executionHostId)
  let repo =
    executionHostId && args.repos
      ? findIndexedRepoOwnerForHost(args.repos, worktree.repoId, executionHostId)
      : null
  if (!repo && worktree.runtimeOwnerEnvironmentId && args.repos) {
    repo = findIndexedRepoOwnerForHost(
      args.repos,
      worktree.repoId,
      toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    )
  }
  const owner: ActivityEventOwner = {
    worktree,
    repo: repo ?? args.repoMap.get(worktree.repoId) ?? null,
    knownWorktree: Boolean(
      resolvedWorktree || mappedWorktree || args.tabsByWorktree[context.worktreeId]
    )
  }
  ownerCache.set(ownerCacheKey, owner)
  return owner
}

export function buildActivityEvents(
  args: BuildActivityEventsArgs,
  cache?: ActivityEventBuildCache
): {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
} {
  const events: ActivityEvent[] = []
  const seenEventIds = new Set<string>()
  const tabContext = new Map<string, ActivityTabContext>()
  const tabHostIndex = buildActivityTabHostIndex(args)
  const ownerCache = new Map<string, ActivityEventOwner>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}
  const seenCacheKeys = cache ? new Set<string>() : null

  const pushPaneEvents = (paneEvents: ActivityEvent[]): void => {
    // Why: a paneKey can appear in more than one source (live + retained overlap);
    // event ids stay globally unique so the first source wins, as before.
    for (const event of paneEvents) {
      if (seenEventIds.has(event.id)) {
        continue
      }
      seenEventIds.add(event.id)
      events.push(event)
    }
  }

  for (const [worktreeId, tabs] of Object.entries(args.tabsByWorktree)) {
    for (const tab of tabs) {
      tabContext.set(tab.id, { worktreeId, tab })
    }
  }

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const context = tabContext.get(parsed.tabId)
    if (!context) {
      continue
    }
    const owner = resolveActivityEventOwner(
      args,
      context,
      entry,
      context.tab.ptyId,
      tabHostIndex,
      ownerCache
    )
    const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
    // Why: live status is separate from history; a fresh working turn updates the thread without counting as an unread done/blocked/waiting event.
    // The freshness check runs on the raw entry (orchestration merges never change state/timing fields).
    const liveState = freshActivityLiveAgentState(entry, args.now)
    const { events: paneEvents, live } = resolvePaneBuild(
      {
        cacheKey: `live:${paneKey}`,
        source: entry,
        entry,
        orchestration,
        worktree: owner.worktree,
        repo: owner.repo,
        tab: context.tab,
        agentType: entry.agentType ?? 'unknown',
        agentAlive: true,
        acknowledgedAt: args.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
        clearedAt: args.activityClearedAtByPaneKey?.[paneKey] ?? 0,
        liveState
      },
      cache,
      seenCacheKeys
    )
    if (live) {
      liveAgentByPaneKey[paneKey] = live
    }
    pushPaneEvents(paneEvents)
  }

  appendUnsupportedAndRetainedEvents({
    args,
    cache,
    seenCacheKeys,
    liveAgentByPaneKey,
    tabContext,
    resolveOwner: (context, entry, terminalPtyId) =>
      resolveActivityEventOwner(args, context, entry, terminalPtyId, tabHostIndex, ownerCache),
    pushPaneEvents
  })

  // Why: evict panes gone from every source so the cache can't outgrow the live state maps.
  if (cache && seenCacheKeys) {
    for (const cacheKey of cache.panes.keys()) {
      if (!seenCacheKeys.has(cacheKey)) {
        cache.panes.delete(cacheKey)
      }
    }
  }
  return { events: capActivityEvents(events), liveAgentByPaneKey }
}
