import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeAgentRowsModule from '../sidebar/worktree-agent-rows'

const rowBuilds = vi.hoisted(() => ({ count: 0 }))

// Why: counts worktrees actually walked per recompute, and works against both
// the memoized and the pre-memo implementation, so the scaling assertions below
// fail loudly if the per-worktree gate regresses.
vi.mock('../sidebar/worktree-agent-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeAgentRowsModule>()
  return {
    ...actual,
    buildWorktreeAgentRows: (args: Parameters<typeof actual.buildWorktreeAgentRows>[0]) => {
      rowBuilds.count += 1
      return actual.buildWorktreeAgentRows(args)
    }
  }
})

import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  buildDashboardBucketCounts,
  resetDashboardBucketCountCachesForTests
} from './build-dashboard-bucket-counts'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  getWorktreeBucketCountRebuildCountForTests,
  resetWorktreeBucketCountCacheForTests
} from './dashboard-worktree-bucket-counts'
import { applyAgentRowLineage } from './agent-row-lineage'
import { collectActiveDashboardWorkspaces } from './dashboard-snapshot-workspaces'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from '../sidebar/worktree-agent-row-selectors'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'

const NOW = 1_700_000_000_000
const REPO_COUNT = 10
const WORKTREE_COUNT = 423
const WORKTREES_WITH_TABS = 193
const TWO_TAB_WORKTREES = 189

/**
 * Byte-for-byte port of the pre-memo implementation, kept as the oracle so a
 * refactor of the cached path cannot silently change a single count.
 */
function referenceBucketCounts(
  state: DashboardSnapshotState,
  now: number
): Record<DashboardBucket, number> {
  const counts = { attention: 0, working: 0, done: 0, idle: 0 }
  const activeWorktrees = collectActiveDashboardWorkspaces(state, false)
  const { singletonOrchestration, orchestrationByWorktree } = selectDashboardOrchestration(
    state,
    activeWorktrees
  )

  for (const { worktree } of activeWorktrees) {
    const worktreeId = worktree.id
    const liveEntries = selectLiveAgentStatusEntriesForWorktree(state, worktreeId)
    const migrationUnsupported = selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
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
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: state.tabsByWorktree[worktreeId] ?? [],
        entries,
        retained: selectRetainedAgentEntriesForWorktree(state, worktreeId),
        runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, worktreeId),
        ptyIdsByTabId: selectLivePtyIdsForWorktree(state, worktreeId),
        terminalLayoutsByTabId: selectTerminalLayoutsForWorktree(state, worktreeId),
        runtimeAgentOrchestrationByPaneKey:
          singletonOrchestration ??
          orchestrationByWorktree?.get(worktreeId) ??
          EMPTY_WORKTREE_AGENT_ORCHESTRATION,
        now
      })
    )

    for (const row of rows) {
      if (row.rowSource === 'subagent') {
        continue
      }
      counts[dashboardRowBucketProjection(row, state.acknowledgedAgentsByPaneKey).bucket] += 1
    }
  }
  return counts
}

function leafId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
}

function tab(id: string, worktreeId: string, title = 'zsh'): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function entry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'do the thing',
    updatedAt: NOW,
    stateStartedAt: NOW - 5_000,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

type ScaleFixture = {
  state: DashboardSnapshotState
  tabIdsByWorktreeId: Map<string, string[]>
  agentPaneKeys: string[]
}

/** 10 repos / 423 worktrees / 193 with tabs / 382 tabs, agents in every bucket. */
function buildScaleFixture(): ScaleFixture {
  const repos: unknown[] = []
  const worktreesByRepo: Record<string, unknown[]> = {}
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  const runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {}
  const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
  const retainedAgentsByPaneKey: Record<string, RetainedAgentEntry> = {}
  const acknowledgedAgentsByPaneKey: Record<string, number> = {}
  const tabIdsByWorktreeId = new Map<string, string[]>()
  const agentPaneKeys: string[] = []

  for (let repoIndex = 0; repoIndex < REPO_COUNT; repoIndex += 1) {
    repos.push({
      id: `r${repoIndex}`,
      path: `/r${repoIndex}`,
      displayName: `Repo ${repoIndex}`,
      badgeColor: '#000'
    })
    worktreesByRepo[`r${repoIndex}`] = []
  }

  let tabCounter = 0
  for (let index = 0; index < WORKTREE_COUNT; index += 1) {
    const worktreeId = `w${index}`
    const repoId = `r${index % REPO_COUNT}`
    worktreesByRepo[repoId].push({
      id: worktreeId,
      repoId,
      path: `/${repoId}/${worktreeId}`,
      head: 'abc123',
      branch: 'main',
      isBare: false,
      isMainWorktree: false,
      displayName: worktreeId,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: NOW
    })

    if (index >= WORKTREES_WITH_TABS) {
      continue
    }
    const tabCount = index < TWO_TAB_WORKTREES ? 2 : 1
    const tabs: TerminalTab[] = []
    for (let slot = 0; slot < tabCount; slot += 1) {
      const tabId = `t${tabCounter}`
      const paneLeafId = leafId(tabCounter)
      tabCounter += 1
      tabs.push(tab(tabId, worktreeId))
      terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId: paneLeafId },
        activeLeafId: paneLeafId,
        ptyIdsByLeafId: { [paneLeafId]: `pty-${tabId}` }
      }
      ptyIdsByTabId[tabId] = [`pty-${tabId}`]

      // Six repeating shapes so every bucket and both decay paths are covered.
      const paneKey = makePaneKey(tabId, paneLeafId)
      switch (tabCounter % 6) {
        case 0:
          agentStatusByPaneKey[paneKey] = entry({ paneKey, state: 'working', worktreeId })
          agentPaneKeys.push(paneKey)
          break
        case 1:
          agentStatusByPaneKey[paneKey] = entry({ paneKey, state: 'blocked', worktreeId })
          agentPaneKeys.push(paneKey)
          break
        case 2:
          agentStatusByPaneKey[paneKey] = entry({ paneKey, state: 'done', worktreeId })
          agentPaneKeys.push(paneKey)
          break
        case 3:
          agentStatusByPaneKey[paneKey] = entry({ paneKey, state: 'done', worktreeId })
          acknowledgedAgentsByPaneKey[paneKey] = NOW
          agentPaneKeys.push(paneKey)
          break
        case 4:
          // Stale non-done entry over a live pty: decays through the row builder.
          agentStatusByPaneKey[paneKey] = entry({
            paneKey,
            state: 'working',
            worktreeId,
            updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1_000
          })
          agentPaneKeys.push(paneKey)
          break
        default:
          // No live entry: exercises the title-derived row path.
          runtimePaneTitlesByTabId[tabId] = { 0: '✳ Cooking… (12s · claude)' }
          break
      }
    }
    tabsByWorktree[worktreeId] = tabs
    tabIdsByWorktreeId.set(worktreeId, tabs.map((t) => t.id))
  }

  // A retained (hibernated) completion on a worktree that has no live entry.
  const retainedTabId = tabsByWorktree.w5[0].id
  const retainedPaneKey = makePaneKey(retainedTabId, leafId(9_000))
  retainedAgentsByPaneKey[retainedPaneKey] = {
    entry: entry({ paneKey: retainedPaneKey, state: 'done', worktreeId: 'w5' }),
    worktreeId: 'w5',
    tab: tab(retainedTabId, 'w5'),
    agentType: 'claude',
    startedAt: NOW - 60_000
  }

  const state = {
    repos,
    worktreesByRepo,
    tabsByWorktree,
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    folderWorkspaces: [],
    acknowledgedAgentsByPaneKey,
    settings: null
  } as unknown as DashboardSnapshotState

  return { state, tabIdsByWorktreeId, agentPaneKeys }
}

function withReplacedStatus(
  state: DashboardSnapshotState,
  paneKey: string,
  overrides: Partial<AgentStatusEntry>
): DashboardSnapshotState {
  return {
    ...state,
    agentStatusByPaneKey: {
      ...state.agentStatusByPaneKey,
      [paneKey]: { ...state.agentStatusByPaneKey[paneKey], ...overrides }
    }
  }
}

function resetCaches(): void {
  resetDashboardBucketCountCachesForTests()
  resetWorktreeBucketCountCacheForTests()
  rowBuilds.count = 0
}

beforeEach(() => {
  resetCaches()
})

describe('buildDashboardBucketCounts scaling', () => {
  it('walks one worktree when one worktree receives an agent status ping', () => {
    const { state, agentPaneKeys } = buildScaleFixture()

    const warm = buildDashboardBucketCounts(state, NOW)
    expect(warm).toEqual(referenceBucketCounts(state, NOW))
    expect(rowBuilds.count).toBeGreaterThan(WORKTREES_WITH_TABS - 1)

    // A same-state prompt update on one pane: exactly the traffic an idle app
    // produces continuously while one agent is running.
    const pinged = withReplacedStatus(state, agentPaneKeys[0], {
      prompt: 'next tool call',
      updatedAt: NOW + 1
    })
    rowBuilds.count = 0
    const after = buildDashboardBucketCounts(pinged, NOW)

    expect(rowBuilds.count).toBe(1)
    expect(after).toEqual(referenceBucketCounts(pinged, NOW))
  })

  it('walks one worktree when one tab publishes a new runtime pane title', () => {
    const { state, tabIdsByWorktreeId } = buildScaleFixture()
    buildDashboardBucketCounts(state, NOW)

    const titledTabId = tabIdsByWorktreeId.get('w2')![0]
    const retitled = {
      ...state,
      runtimePaneTitlesByTabId: {
        ...state.runtimePaneTitlesByTabId,
        [titledTabId]: { 0: '✳ Reticulating… (3s · claude)' }
      }
    } as DashboardSnapshotState
    rowBuilds.count = 0
    const after = buildDashboardBucketCounts(retitled, NOW)

    expect(rowBuilds.count).toBe(1)
    expect(after).toEqual(referenceBucketCounts(retitled, NOW))
  })

  it('walks nothing when the same store snapshot is re-derived', () => {
    const { state } = buildScaleFixture()
    const first = buildDashboardBucketCounts(state, NOW)
    rowBuilds.count = 0
    const rebuildsBefore = getWorktreeBucketCountRebuildCountForTests()

    const second = buildDashboardBucketCounts(state, NOW)

    expect(rowBuilds.count).toBe(0)
    expect(getWorktreeBucketCountRebuildCountForTests()).toBe(rebuildsBefore)
    expect(second).toEqual(first)
  })

  it('re-walks only the worktrees whose rows can cross the stale boundary', () => {
    const { state } = buildScaleFixture()
    buildDashboardBucketCounts(state, NOW)
    rowBuilds.count = 0

    // Every live entry's freshness deadline has passed, so every worktree that
    // holds one must be re-derived — but the ~230 workspaces with no tabs and
    // the tabbed worktrees with no live entry must not be.
    const later = NOW + AGENT_STATUS_STALE_AFTER_MS + 1
    const decayed = buildDashboardBucketCounts(state, later)
    const walked = rowBuilds.count

    expect(decayed).toEqual(referenceBucketCounts(state, later))
    expect(walked).toBeGreaterThan(0)
    expect(walked).toBeLessThanOrEqual(WORKTREES_WITH_TABS)
  })
})

describe('buildDashboardBucketCounts equivalence', () => {
  it('matches the pre-memo implementation across a matrix of states', () => {
    const { state, agentPaneKeys, tabIdsByWorktreeId } = buildScaleFixture()
    const paneKey = agentPaneKeys[0]
    const otherPaneKey = agentPaneKeys[7]
    const tabId = tabIdsByWorktreeId.get('w3')![0]

    const matrix: { name: string; state: DashboardSnapshotState; now: number }[] = [
      { name: 'baseline', state, now: NOW },
      {
        name: 'blocked -> working',
        state: withReplacedStatus(state, paneKey, { state: 'working' }),
        now: NOW
      },
      {
        name: 'working -> done unseen',
        state: withReplacedStatus(state, paneKey, { state: 'done', stateStartedAt: NOW }),
        now: NOW
      },
      {
        name: 'acknowledged completion',
        state: {
          ...state,
          acknowledgedAgentsByPaneKey: {
            ...state.acknowledgedAgentsByPaneKey,
            [otherPaneKey]: NOW + 1
          }
        } as DashboardSnapshotState,
        now: NOW
      },
      {
        name: 'subagent children are excluded',
        state: withReplacedStatus(state, paneKey, {
          subagents: [
            { id: 's1', state: 'working', startedAt: NOW - 1_000, agentType: 'claude' },
            { id: 's2', state: 'done', startedAt: NOW - 2_000, agentType: 'claude' }
          ]
        } as Partial<AgentStatusEntry>),
        now: NOW
      },
      {
        name: 'pty closed under a titled pane',
        state: {
          ...state,
          ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId]: [] }
        } as DashboardSnapshotState,
        now: NOW
      },
      {
        name: 'tab removed from a worktree',
        state: {
          ...state,
          tabsByWorktree: { ...state.tabsByWorktree, w4: [] }
        } as DashboardSnapshotState,
        now: NOW
      },
      { name: 'past the stale boundary', state, now: NOW + AGENT_STATUS_STALE_AFTER_MS + 1 },
      { name: 'far past the stale boundary', state, now: NOW + AGENT_STATUS_STALE_AFTER_MS * 4 }
    ]

    // Run twice: once cold, once against the warm cache left by the previous case.
    for (const pass of [1, 2]) {
      for (const { name, state: caseState, now } of matrix) {
        expect(
          { name, pass, counts: buildDashboardBucketCounts(caseState, now) },
          `${name} (pass ${pass})`
        ).toEqual({ name, pass, counts: referenceBucketCounts(caseState, now) })
      }
    }
  })

  it('returns the shared empty-counts constant when every bucket is zero', () => {
    const emptyState = {
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      runtimePaneTitlesByTabId: {},
      folderWorkspaces: [],
      acknowledgedAgentsByPaneKey: {},
      settings: null
    } as unknown as DashboardSnapshotState
    const otherEmptyState = { ...emptyState, repos: [] } as DashboardSnapshotState

    const first = buildDashboardBucketCounts(emptyState, NOW)
    const second = buildDashboardBucketCounts(otherEmptyState, NOW)

    expect(first).toEqual({ attention: 0, working: 0, done: 0, idle: 0 })
    expect(second).toBe(first)
  })
})
