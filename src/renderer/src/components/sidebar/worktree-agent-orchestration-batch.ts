import type { AppState } from '@/store/types'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

type RuntimeOrchestrationState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'tabsByWorktree'
>

type RuntimeOrchestrationMap = RuntimeOrchestrationState['runtimeAgentOrchestrationByPaneKey']
type RuntimeOrchestrationRecord = Record<string, AgentStatusOrchestrationContext>

type RuntimeDomainCache = {
  source: RuntimeOrchestrationMap
  orderedEntries: [string, AgentStatusOrchestrationContext][]
}

type RequestedTabMembershipCache = {
  tabsSource: RuntimeOrchestrationState['tabsByWorktree']
  requestedWorktreeIds: readonly string[]
  requestedIds: Set<string>
  worktreeIdsByTabId: Map<string, Set<string>>
}

/**
 * Everything `buildRuntimeBatch` is allowed to read. The live and retained maps are not in
 * here and not in its scope; they reach it only as `paneWorktreeIds`. Anything a future build
 * needs has to be added here, and this record is also the cache key, so the key cannot drift
 * from the read set.
 */
type RuntimeBatchInputs = {
  runtimeSource: RuntimeOrchestrationMap
  tabsSource: RuntimeOrchestrationState['tabsByWorktree']
  paneWorktreeIds: readonly (string | undefined)[]
  requestedWorktreeIds: readonly string[]
}

type RuntimeBatchCache = {
  inputs: RuntimeBatchInputs
  recordsByWorktree: ReadonlyMap<string, RuntimeOrchestrationRecord>
}

const EMPTY_RUNTIME_ORCHESTRATION: RuntimeOrchestrationMap = {}
const EMPTY_TABS_BY_WORKTREE: RuntimeOrchestrationState['tabsByWorktree'] = {}
const EMPTY_AGENT_STATUS: RuntimeOrchestrationState['agentStatusByPaneKey'] = {}
const EMPTY_RETAINED_AGENTS: RuntimeOrchestrationState['retainedAgentsByPaneKey'] = {}
const EMPTY_BATCH: ReadonlyMap<string, RuntimeOrchestrationRecord> = new Map()

export const EMPTY_WORKTREE_AGENT_ORCHESTRATION: RuntimeOrchestrationRecord = Object.freeze({})

// Why null-prototype: a pane key of `__proto__` is a plain data key here; on a
// normal object the write vanishes into the prototype setter and repoints it.
function createRecord(): RuntimeOrchestrationRecord {
  return Object.create(null) as RuntimeOrchestrationRecord
}

let runtimeDomainCache: RuntimeDomainCache | null = null
let requestedTabMembershipCache: RequestedTabMembershipCache | null = null
let runtimeBatchCache: RuntimeBatchCache | null = null
let runtimeBatchBuildCount = 0
let uniqueWorktreeIdComputeCount = 0

export function releaseRuntimeAgentOrchestrationBatchCache(): void {
  runtimeDomainCache = null
  requestedTabMembershipCache = null
  runtimeBatchCache = null
}

export function _getRuntimeAgentOrchestrationBatchCountersForTest(): {
  builds: number
  uniqueIdComputations: number
} {
  return { builds: runtimeBatchBuildCount, uniqueIdComputations: uniqueWorktreeIdComputeCount }
}

function getOrderedRuntimeEntries(
  runtimeAgentOrchestrationByPaneKey: RuntimeOrchestrationMap
): [string, AgentStatusOrchestrationContext][] {
  if (runtimeDomainCache?.source === runtimeAgentOrchestrationByPaneKey) {
    return runtimeDomainCache.orderedEntries
  }
  const orderedEntries = Object.entries(runtimeAgentOrchestrationByPaneKey)
  runtimeDomainCache = { source: runtimeAgentOrchestrationByPaneKey, orderedEntries }
  return orderedEntries
}

// Why: the dashboard re-derives this list on every agent-status write. Keying on the caller's
// array identity lets the snapshot path (fresh array per call) miss without evicting the
// memoised sidebar path. Callers must not mutate an array they have already passed in.
const uniqueWorktreeIdsByInput = new WeakMap<readonly string[], string[]>()

function uniqueWorktreeIds(worktreeIds: readonly string[]): string[] {
  const memoized = uniqueWorktreeIdsByInput.get(worktreeIds)
  if (memoized) {
    return memoized
  }
  uniqueWorktreeIdComputeCount += 1
  const uniqueIds: string[] = []
  const seen = new Set<string>()
  for (const worktreeId of worktreeIds) {
    if (!seen.has(worktreeId)) {
      seen.add(worktreeId)
      uniqueIds.push(worktreeId)
    }
  }
  uniqueWorktreeIdsByInput.set(worktreeIds, uniqueIds)
  return uniqueIds
}

function hasSameOrderedValues(previous: readonly unknown[], next: readonly unknown[]): boolean {
  if (previous === next) {
    return true
  }
  if (previous.length !== next.length) {
    return false
  }
  return previous.every((value, index) => value === next[index])
}

function runtimeBatchInputsEqual(previous: RuntimeBatchInputs, next: RuntimeBatchInputs): boolean {
  return (
    previous.runtimeSource === next.runtimeSource &&
    previous.tabsSource === next.tabsSource &&
    hasSameOrderedValues(previous.paneWorktreeIds, next.paneWorktreeIds) &&
    hasSameOrderedValues(previous.requestedWorktreeIds, next.requestedWorktreeIds)
  )
}

/**
 * The batch's whole view of the live and retained maps: the `worktreeId` each orchestrated
 * pane key resolves to, as live,retained pairs in ordered-entry order. A status write for any
 * other pane cannot change the batch, so this projection — not the map identities — is the
 * correct cache key. Exact runtime keys preserve early SSH attribution and ignore stale
 * `entry.paneKey` fields carried by a live or retained row.
 */
function projectPaneWorktreeIds(
  orderedRuntimeEntries: readonly [string, AgentStatusOrchestrationContext][],
  agentStatusByPaneKey: RuntimeOrchestrationState['agentStatusByPaneKey'],
  retainedAgentsByPaneKey: RuntimeOrchestrationState['retainedAgentsByPaneKey']
): (string | undefined)[] {
  const paneWorktreeIds: (string | undefined)[] = []
  for (const [paneKey] of orderedRuntimeEntries) {
    paneWorktreeIds.push(
      agentStatusByPaneKey[paneKey]?.worktreeId,
      retainedAgentsByPaneKey[paneKey]?.worktreeId
    )
  }
  return paneWorktreeIds
}

function getRequestedTabMembership(
  tabsByWorktree: RuntimeOrchestrationState['tabsByWorktree'],
  requestedWorktreeIds: readonly string[]
): RequestedTabMembershipCache {
  if (
    requestedTabMembershipCache?.tabsSource === tabsByWorktree &&
    hasSameOrderedValues(requestedTabMembershipCache.requestedWorktreeIds, requestedWorktreeIds)
  ) {
    return requestedTabMembershipCache
  }

  const requestedIds = new Set(requestedWorktreeIds)
  const worktreeIdsByTabId = new Map<string, Set<string>>()
  for (const worktreeId of requestedWorktreeIds) {
    // Why: the batch must not make a singleton dashboard scan unrelated tabs.
    for (const tab of tabsByWorktree[worktreeId] ?? []) {
      const tabId = tab.id
      const existing = worktreeIdsByTabId.get(tabId)
      if (existing) {
        existing.add(worktreeId)
      } else {
        worktreeIdsByTabId.set(tabId, new Set([worktreeId]))
      }
    }
  }
  requestedTabMembershipCache = {
    tabsSource: tabsByWorktree,
    requestedWorktreeIds,
    requestedIds,
    worktreeIdsByTabId
  }
  return requestedTabMembershipCache
}

function reuseRecordIfOrderedEqual(
  previous: RuntimeOrchestrationRecord | undefined,
  next: RuntimeOrchestrationRecord
): RuntimeOrchestrationRecord {
  if (!previous) {
    return next
  }
  const previousEntries = Object.entries(previous)
  const nextEntries = Object.entries(next)
  if (previousEntries.length !== nextEntries.length) {
    return next
  }
  for (let index = 0; index < nextEntries.length; index += 1) {
    if (
      previousEntries[index]?.[0] !== nextEntries[index]?.[0] ||
      previousEntries[index]?.[1] !== nextEntries[index]?.[1]
    ) {
      return next
    }
  }
  return previous
}

function buildRuntimeBatch(
  inputs: RuntimeBatchInputs,
  orderedRuntimeEntries: [string, AgentStatusOrchestrationContext][]
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  runtimeBatchBuildCount += 1
  const { requestedIds, worktreeIdsByTabId } = getRequestedTabMembership(
    inputs.tabsSource,
    inputs.requestedWorktreeIds
  )

  const recordsByWorktree = new Map<string, RuntimeOrchestrationRecord>()
  let projectionCursor = 0
  for (const [paneKey, orchestration] of orderedRuntimeEntries) {
    const targets = new Set<string>()
    const parsed = parsePaneKey(paneKey)
    const parsedParent = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)
      : null
    if (parsed) {
      for (const worktreeId of worktreeIdsByTabId.get(parsed.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }
    if (parsedParent) {
      for (const worktreeId of worktreeIdsByTabId.get(parsedParent.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }

    const liveWorktreeId = inputs.paneWorktreeIds[projectionCursor]
    const retainedWorktreeId = inputs.paneWorktreeIds[projectionCursor + 1]
    projectionCursor += 2
    if (typeof liveWorktreeId === 'string' && requestedIds.has(liveWorktreeId)) {
      targets.add(liveWorktreeId)
    }
    if (typeof retainedWorktreeId === 'string' && requestedIds.has(retainedWorktreeId)) {
      targets.add(retainedWorktreeId)
    }

    for (const worktreeId of targets) {
      let record = recordsByWorktree.get(worktreeId)
      if (!record) {
        record = createRecord()
        recordsByWorktree.set(worktreeId, record)
      }
      record[paneKey] = orchestration
    }
  }

  const previousRecords = runtimeBatchCache?.recordsByWorktree
  for (const [worktreeId, record] of recordsByWorktree) {
    recordsByWorktree.set(
      worktreeId,
      reuseRecordIfOrderedEqual(previousRecords?.get(worktreeId), record)
    )
  }
  return recordsByWorktree
}

export function selectRuntimeAgentOrchestrationBatch(
  state: RuntimeOrchestrationState,
  worktreeIds: readonly string[]
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  const requestedWorktreeIds = uniqueWorktreeIds(worktreeIds)
  if (requestedWorktreeIds.length === 0) {
    releaseRuntimeAgentOrchestrationBatchCache()
    return EMPTY_BATCH
  }

  const runtimeAgentOrchestrationByPaneKey =
    state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_RUNTIME_ORCHESTRATION
  const orderedRuntimeEntries = getOrderedRuntimeEntries(runtimeAgentOrchestrationByPaneKey)
  if (orderedRuntimeEntries.length === 0) {
    releaseRuntimeAgentOrchestrationBatchCache()
    return EMPTY_BATCH
  }

  const inputs: RuntimeBatchInputs = {
    runtimeSource: runtimeAgentOrchestrationByPaneKey,
    tabsSource: state.tabsByWorktree ?? EMPTY_TABS_BY_WORKTREE,
    paneWorktreeIds: projectPaneWorktreeIds(
      orderedRuntimeEntries,
      state.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS,
      state.retainedAgentsByPaneKey ?? EMPTY_RETAINED_AGENTS
    ),
    requestedWorktreeIds
  }
  if (runtimeBatchCache && runtimeBatchInputsEqual(runtimeBatchCache.inputs, inputs)) {
    return runtimeBatchCache.recordsByWorktree
  }

  // buildRuntimeBatch reuses the previous records, so publish the new cache only after it runs.
  const recordsByWorktree = buildRuntimeBatch(inputs, orderedRuntimeEntries)
  runtimeBatchCache = { inputs, recordsByWorktree }
  return recordsByWorktree
}
