import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import {
  VISIBILITY_INVENTORY_REMOVAL_EPOCH,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  latestSessionTabsSnapshotByWorktree,
  lastHostTerminalTabCountByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsRecoveryStateByWorktree,
  trackedSessionTabsWorktreeIdsByEnvironment,
  nextReceivedSessionTabsFrame,
  type SnapshotFreshness,
  type SessionTabsListAllResult,
  type TrackedWebSessionTabsWorktree
} from './state'

export function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
}

export function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

export function advancesSessionTabsFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  baseline: SnapshotFreshness
): boolean {
  return (
    snapshot.publicationEpoch !== baseline.publicationEpoch ||
    snapshot.snapshotVersion > baseline.snapshotVersion
  )
}

export function getTrackedWebSessionTabsWorktrees(
  environmentId: string
): TrackedWebSessionTabsWorktree[] {
  return [...(trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? [])].flatMap(
    (worktree) => {
      const key = sessionTabsFreshnessKey(environmentId, worktree)
      const freshness = latestSessionTabsSnapshotByWorktree.get(key)
      return freshness
        ? [
            {
              worktree,
              freshness
            }
          ]
        : []
    }
  )
}

export function trackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId) ?? new Set()
  worktrees.add(worktreeId)
  trackedSessionTabsWorktreeIdsByEnvironment.set(environmentId, worktrees)
}

export function untrackWebSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  const worktrees = trackedSessionTabsWorktreeIdsByEnvironment.get(environmentId)
  if (!worktrees) {
    return
  }
  worktrees.delete(worktreeId)
  if (worktrees.size === 0) {
    trackedSessionTabsWorktreeIdsByEnvironment.delete(environmentId)
  }
}

export function recordReceivedWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): number {
  const receivedFrame = nextReceivedSessionTabsFrame()
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  latestReceivedSessionTabsSnapshotByWorktree.set(key, {
    receivedFrame,
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion
  })
  if ((snapshot as { removed?: unknown }).removed === true) {
    recordReceivedWebSessionTabsRemoval(environmentId, snapshot.worktree, receivedFrame)
  }
  return receivedFrame
}

export function recordReceivedWebSessionTabsInventory(): number {
  return nextReceivedSessionTabsFrame()
}

export function beginWebSessionTabsSnapshotRecovery(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number
): () => void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const recoveryState = sessionTabsRecoveryStateByWorktree.get(key) ?? { pendingCount: 0 }
  recoveryState.pendingCount += 1
  sessionTabsRecoveryStateByWorktree.set(key, recoveryState)
  let settled = false
  return () => {
    if (settled) {
      return
    }
    settled = true
    recoveryState.pendingCount -= 1
    if (
      recoveryState.pendingCount === 0 &&
      sessionTabsRecoveryStateByWorktree.get(key) === recoveryState
    ) {
      sessionTabsRecoveryStateByWorktree.delete(key)
    }
    const removalFence = latestSessionTabsRemovalFenceByWorktree.get(key)
    if (
      removalFence?.recoveryState === recoveryState &&
      receivedFrame < removalFence.receivedFrame
    ) {
      removalFence.pendingCount -= 1
      if (removalFence.pendingCount === 0) {
        latestSessionTabsRemovalFenceByWorktree.delete(key)
      }
    }
  }
}

export function recordReceivedWebSessionTabsRemoval(
  environmentId: string,
  worktreeId: string,
  receivedFrame: number
): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const current = latestSessionTabsRemovalFenceByWorktree.get(key)
  if (current && current.receivedFrame >= receivedFrame) {
    return
  }
  const recoveryState = sessionTabsRecoveryStateByWorktree.get(key)
  if (!recoveryState || recoveryState.pendingCount === 0) {
    latestSessionTabsRemovalFenceByWorktree.delete(key)
    return
  }
  latestSessionTabsRemovalFenceByWorktree.set(key, {
    receivedFrame,
    recoveryState,
    pendingCount: recoveryState.pendingCount
  })
}

export function shouldApplyRecoveredWebSessionTabsSnapshot(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const removalFrame = latestSessionTabsRemovalFenceByWorktree.get(key)?.receivedFrame
  if (removalFrame !== undefined && receivedFrame < removalFrame) {
    return false
  }
  const latest = latestReceivedSessionTabsSnapshotByWorktree.get(key)
  if (!latest || latest.receivedFrame === receivedFrame) {
    return latest !== undefined
  }
  if (latest.publicationEpoch !== snapshot.publicationEpoch) {
    return receivedFrame > latest.receivedFrame
  }
  return snapshot.snapshotVersion >= latest.snapshotVersion
}

export function isTrackedWebSessionTabsOmissionCurrent(
  environmentId: string,
  trackedWorktree: TrackedWebSessionTabsWorktree
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, trackedWorktree.worktree)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  return (
    current?.publicationEpoch === trackedWorktree.freshness.publicationEpoch &&
    current.snapshotVersion === trackedWorktree.freshness.snapshotVersion
  )
}

export function recordAcceptedWebSessionTabsEnvironment(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(snapshot.worktree) ?? [])
  if (snapshot.tabs.length > 0) {
    environments.add(environmentId)
  } else {
    environments.delete(environmentId)
  }
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(snapshot.worktree, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(snapshot.worktree)
  }
}

export function removeWebSessionTabsEnvironment(environmentId: string, worktreeId: string): void {
  const environments = new Set(sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? [])
  environments.delete(environmentId)
  if (environments.size > 0) {
    sessionTabsEnvironmentsByWorktree.set(worktreeId, environments)
  } else {
    sessionTabsEnvironmentsByWorktree.delete(worktreeId)
  }
}

// Why: a tombstone empties the whole worktree mirror — including tabs a still-live sibling environment publishes — so it is a
// visibility fact, never evidence that the host closed anything.
export function isWebSessionTabsWorktreeRemovalFrame(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  return (
    (snapshot as { removed?: unknown }).removed === true ||
    snapshot.publicationEpoch === VISIBILITY_INVENTORY_REMOVAL_EPOCH
  )
}

// Why: omission means removal only because `listAllMobileSessionTabs` publishes every worktree it knows unfiltered; if a host ever
// scopes that map, this turns live worktrees into tombstones, so the fence below is deliberately short-lived.
export function buildMissingWebSessionTabsRemovals(
  environmentId: string,
  trackedWorktrees: readonly TrackedWebSessionTabsWorktree[],
  publishedWorktrees: ReadonlySet<string>
): {
  trackedWorktree: TrackedWebSessionTabsWorktree
  snapshot: RuntimeMobileSessionTabsRemovedResult
}[] {
  return trackedWorktrees
    .filter(
      (trackedWorktree) =>
        !publishedWorktrees.has(trackedWorktree.worktree) &&
        isTrackedWebSessionTabsOmissionCurrent(environmentId, trackedWorktree)
    )
    .map((trackedWorktree) => ({
      trackedWorktree,
      snapshot: {
        worktree: trackedWorktree.worktree,
        publicationEpoch: VISIBILITY_INVENTORY_REMOVAL_EPOCH,
        snapshotVersion: 0,
        removed: true,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    }))
}

export function rememberHostTerminalTabCount(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}
