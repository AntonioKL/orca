import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { applyAgentRowLineage } from './agent-row-lineage'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from '../sidebar/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'

export type WorktreeBucketCounts = Record<DashboardBucket, number>

const EMPTY_TABS: TerminalTab[] = []
// Why: unit tests pass partial store mocks; a missing map must behave like an
// empty slice while keeping one stable identity for the cache keys below.
const EMPTY_RECORD: Record<string, never> = {}
const ZERO_COUNTS: WorktreeBucketCounts = Object.freeze({
  attention: 0,
  working: 0,
  done: 0,
  idle: 0
})

type WorktreeBucketCountsCacheEntry = {
  tabs: TerminalTab[]
  liveEntries: AgentStatusEntry[]
  migrationUnsupported: MigrationUnsupportedPtyEntry[]
  retained: RetainedAgentEntry[]
  orchestration: Record<string, AgentStatusOrchestrationContext>
  acknowledgedAgentsByPaneKey: unknown
  terminalLayoutsByTabId: unknown
  runtimePaneTitlesByTabId: unknown
  ptyIdsByTabId: unknown
  layoutByTab: (TerminalLayoutSnapshot | undefined)[]
  paneTitlesByTab: (Record<number, string> | undefined)[]
  ptyIdsByTab: (string[] | undefined)[]
  computedAt: number
  /**
   * Latest `now` this contribution still describes. Row buckets read the clock
   * only through `isExplicitAgentStatusFresh`, so the answer can only change
   * when an entry crosses `evidenceObservedAt + AGENT_STATUS_STALE_AFTER_MS` —
   * the same boundary the store's freshness scheduler bumps `agentStatusEpoch` on.
   */
  validUntil: number
  counts: WorktreeBucketCounts
}

let cacheByWorktreeId = new Map<string, WorktreeBucketCountsCacheEntry>()
let liveEntriesThisPass = 0
let rebuildCount = 0

/** Test-only: proves one worktree's status change rebuilds one worktree. */
export function getWorktreeBucketCountRebuildCountForTests(): number {
  return rebuildCount
}

export function resetWorktreeBucketCountCacheForTests(): void {
  cacheByWorktreeId = new Map()
  liveEntriesThisPass = 0
  rebuildCount = 0
}

/**
 * Close a full pass. Any cached contribution the pass did not touch belongs to
 * a worktree that is gone, so the map is dropped rather than kept forever.
 */
export function endWorktreeBucketCountPass(): void {
  if (cacheByWorktreeId.size > liveEntriesThisPass) {
    cacheByWorktreeId = new Map()
  }
  liveEntriesThisPass = 0
}

function nextFreshnessBoundary(entries: AgentStatusEntry[], now: number): number {
  let validUntil = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    // Why skipped: a restored-unconfirmed entry is never fresh at any clock
    // reading, so it has no future transition to invalidate this contribution.
    if (entry.restoredUnconfirmed === true) {
      continue
    }
    const expiryAt = agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS
    if (expiryAt >= now && expiryAt < validUntil) {
      validUntil = expiryAt
    }
  }
  return validUntil
}

function perTabInputsUnchanged(
  cached: WorktreeBucketCountsCacheEntry,
  tabs: TerminalTab[],
  layoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>,
  paneTitlesByTabId: Record<string, Record<number, string> | undefined>,
  ptyIdsByTabId: Record<string, string[] | undefined>
): boolean {
  if (
    cached.terminalLayoutsByTabId === layoutsByTabId &&
    cached.runtimePaneTitlesByTabId === paneTitlesByTabId &&
    cached.ptyIdsByTabId === ptyIdsByTabId
  ) {
    return true
  }
  // Why per tab: one tab's title, layout, or pty write mints a new global map,
  // but only the worktree owning that tab can change bucket because of it.
  for (let index = 0; index < tabs.length; index += 1) {
    const tabId = tabs[index].id
    if (
      cached.layoutByTab[index] !== layoutsByTabId[tabId] ||
      cached.paneTitlesByTab[index] !== paneTitlesByTabId[tabId] ||
      cached.ptyIdsByTab[index] !== ptyIdsByTabId[tabId]
    ) {
      return false
    }
  }
  return true
}

function countRowBuckets(args: {
  state: DashboardSnapshotState
  worktreeId: string
  tabs: TerminalTab[]
  entries: AgentStatusEntry[]
  retained: RetainedAgentEntry[]
  orchestration: Record<string, AgentStatusOrchestrationContext>
  now: number
}): WorktreeBucketCounts {
  const counts: WorktreeBucketCounts = { attention: 0, working: 0, done: 0, idle: 0 }
  const rows = applyAgentRowLineage(
    buildWorktreeAgentRows({
      tabs: args.tabs,
      entries: args.entries,
      retained: args.retained,
      runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(args.state, args.worktreeId),
      ptyIdsByTabId: selectLivePtyIdsForWorktree(args.state, args.worktreeId),
      terminalLayoutsByTabId: selectTerminalLayoutsForWorktree(args.state, args.worktreeId),
      runtimeAgentOrchestrationByPaneKey: args.orchestration,
      now: args.now
    })
  )
  for (const row of rows) {
    if (row.rowSource === 'subagent') {
      continue
    }
    counts[dashboardRowBucketProjection(row, args.state.acknowledgedAgentsByPaneKey).bucket] += 1
  }
  return counts
}

/**
 * One worktree's contribution to the sidebar bucket counts, memoized on that
 * worktree's own input identities plus the clock boundary above.
 *
 * Why: an agent ping mints new global slice maps, but the indexed selectors in
 * worktree-agent-row-selectors keep every unaffected worktree's derived arrays
 * reference-equal. Without this gate the counts re-walked every worktree x tab
 * x pane on traffic that could only move one worktree.
 */
export function selectWorktreeBucketCounts(
  state: DashboardSnapshotState,
  worktreeId: string,
  orchestration: Record<string, AgentStatusOrchestrationContext>,
  now: number
): WorktreeBucketCounts {
  const tabs = state.tabsByWorktree?.[worktreeId] ?? EMPTY_TABS
  const liveEntries = selectLiveAgentStatusEntriesForWorktree(state, worktreeId)
  const migrationUnsupported = selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
  const retained = selectRetainedAgentEntriesForWorktree(state, worktreeId)
  const cached = cacheByWorktreeId.get(worktreeId)
  if (
    tabs.length === 0 &&
    liveEntries.length === 0 &&
    migrationUnsupported.length === 0 &&
    retained.length === 0
  ) {
    // Why: with no tabs and no entries the row builder provably yields no rows,
    // so a workspace that was never opened costs four length checks.
    if (cached) {
      cacheByWorktreeId.delete(worktreeId)
    }
    return ZERO_COUNTS
  }

  const layoutsByTabId = state.terminalLayoutsByTabId ?? EMPTY_RECORD
  const paneTitlesByTabId = state.runtimePaneTitlesByTabId ?? EMPTY_RECORD
  const ptyIdsByTabId = state.ptyIdsByTabId ?? EMPTY_RECORD
  if (
    cached &&
    cached.tabs === tabs &&
    cached.liveEntries === liveEntries &&
    cached.migrationUnsupported === migrationUnsupported &&
    cached.retained === retained &&
    cached.orchestration === orchestration &&
    cached.acknowledgedAgentsByPaneKey === state.acknowledgedAgentsByPaneKey &&
    now >= cached.computedAt &&
    now <= cached.validUntil &&
    perTabInputsUnchanged(cached, tabs, layoutsByTabId, paneTitlesByTabId, ptyIdsByTabId)
  ) {
    liveEntriesThisPass += 1
    return cached.counts
  }

  rebuildCount += 1
  const entries =
    migrationUnsupported.length > 0
      ? [
          ...liveEntries,
          ...migrationUnsupported.flatMap((unsupported) => {
            const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
            return entry ? [entry] : []
          })
        ]
      : liveEntries
  const counts = countRowBuckets({
    state,
    worktreeId,
    tabs,
    entries,
    retained,
    orchestration,
    now
  })

  const layoutByTab: (TerminalLayoutSnapshot | undefined)[] = []
  const paneTitlesByTab: (Record<number, string> | undefined)[] = []
  const ptyIdsByTab: (string[] | undefined)[] = []
  for (const tab of tabs) {
    layoutByTab.push(layoutsByTabId[tab.id])
    paneTitlesByTab.push(paneTitlesByTabId[tab.id])
    ptyIdsByTab.push(ptyIdsByTabId[tab.id])
  }
  cacheByWorktreeId.set(worktreeId, {
    tabs,
    liveEntries,
    migrationUnsupported,
    retained,
    orchestration,
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
    terminalLayoutsByTabId: layoutsByTabId,
    runtimePaneTitlesByTabId: paneTitlesByTabId,
    ptyIdsByTabId,
    layoutByTab,
    paneTitlesByTab,
    ptyIdsByTab,
    computedAt: now,
    validUntil: nextFreshnessBoundary(entries, now),
    counts
  })
  liveEntriesThisPass += 1
  return counts
}
