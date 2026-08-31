import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { isRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import { useAppStore } from '../../store'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import {
  beginWebSessionTabsSnapshotRecovery,
  recordReceivedWebSessionTabsInventory,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './tracking'
import {
  decideWebSessionTabsSnapshot,
  WEB_SESSION_TABS_FRAME_OUTRANKED
} from './tracking-decisions'
import { acceptReplayedWebSessionTabsSnapshot } from './tracking-lifecycle'
import { applyWebSessionTabsSnapshot, applyWebSessionTabsSnapshots } from './snapshot-api'
import {
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree
} from './state'
import { applyWebSessionTabsStorePatch } from './store-patch'
import {
  hostSessionMirrorSettleForPatchlessFrame,
  type HostSessionMirrorSettle
} from './mirror-settle'
import { queueAcceptedWebSessionTerminalSnapshot } from '../web-session-terminal-handle-events'
import { isHostMirroredWorktree } from './visibility-types'
import type { VisibilityResumeCoordinator } from './visibility-resume-coordinator'

export type GlobalSessionEventArgs = {
  environmentId: string
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration: number
  visibilityGeneration: number
  isCurrent: () => boolean
  event: unknown
  response: RuntimeRpcResponse<unknown>
  awaitingVisibilityResumeInventory: { value: boolean }
  coordinator: VisibilityResumeCoordinator
}

/** Apply one event from the all-worktrees stream, including visibility inventory fencing. */
export function handleGlobalSessionEvent(args: GlobalSessionEventArgs): void {
  const {
    environmentId,
    expectedEnvironmentConnectionGeneration,
    expectedEnvironmentPairingRevision,
    expectedTrackingGeneration,
    visibilityGeneration,
    isCurrent,
    response,
    awaitingVisibilityResumeInventory,
    coordinator
  } = args
  if (!isCurrent()) {
    return
  }
  if (response.ok === false) {
    console.warn('[web-session-tabs-sync] global subscription failed:', response.error.message)
    return
  }
  const event = args.event as
    | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
    | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: boolean }
    | { type: 'end' }
  const replayed = isRuntimeSubscriptionReplayResponse(response)
  if (event.type === 'snapshots') {
    const skipUnchangedResumeWork = awaitingVisibilityResumeInventory.value && !replayed
    awaitingVisibilityResumeInventory.value = false
    const unchanged = event.snapshots.map((snapshot) => {
      const key = `${environmentId}:${snapshot.worktree}`
      const freshness = getLatestFreshness(key)
      return Boolean(
        skipUnchangedResumeWork &&
        !hasReplayAllowance(key) &&
        freshness?.publicationEpoch === snapshot.publicationEpoch &&
        freshness.snapshotVersion === snapshot.snapshotVersion
      )
    })
    const receivedFrames = event.snapshots.map((snapshot) => {
      const frame = recordReceivedWebSessionTabsSnapshot(environmentId, snapshot)
      coordinator.recordSnapshotReceipt(environmentId, snapshot, frame)
      return frame
    })
    const inventoryFrame = recordReceivedWebSessionTabsInventory()
    const missing = coordinator.recordInventoryReceipt(
      environmentId,
      visibilityGeneration,
      inventoryFrame,
      event.snapshots
    )
    const finishRecoveries = event.snapshots.map((snapshot, index) =>
      unchanged[index]
        ? null
        : beginWebSessionTabsSnapshotRecovery(
            environmentId,
            snapshot.worktree,
            receivedFrames[index]!
          )
    )
    let settleHydration: (() => void) | null = null
    void Promise.all(
      event.snapshots.map((snapshot, index) =>
        unchanged[index]
          ? Promise.resolve(snapshot)
          : recoverWebSessionTerminalOrphansBeforeApply(
              useAppStore.getState(),
              snapshot,
              environmentId
            )
      )
    )
      .then((recovered) => {
        if (!isCurrent()) {
          return
        }
        const applicable = recovered.flatMap((snapshot, index) =>
          snapshot !== null &&
          shouldApplyRecoveredWebSessionTabsSnapshot(
            environmentId,
            snapshot,
            receivedFrames[index]!
          ) &&
          coordinator.shouldApplySnapshot(environmentId, snapshot, receivedFrames[index]!)
            ? [{ index, snapshot }]
            : []
        )
        if (visibilityGeneration > 0 || replayed) {
          for (const { index, snapshot } of applicable) {
            if (!unchanged[index]) {
              acceptReplayedWebSessionTabsSnapshot(environmentId, snapshot.worktree)
            }
          }
        }
        const decisions = applicable.map(({ index, snapshot }) =>
          unchanged[index]
            ? WEB_SESSION_TABS_FRAME_OUTRANKED
            : decideWebSessionTabsSnapshot(snapshot, environmentId)
        )
        const freshSnapshots = applicable.flatMap(({ snapshot }, index) =>
          decisions[index]!.apply ? [snapshot] : []
        )
        settleHydration = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId),
          {
            frames: applicable.map(({ snapshot }, index) => ({
              environmentId,
              worktreeId: snapshot.worktree,
              decision: decisions[index]!,
              expectedEnvironmentConnectionGeneration,
              expectedEnvironmentPairingRevision,
              expectedTrackingGeneration
            })),
            fullInventory: {
              environmentId,
              authoritative: event.authoritative === true,
              expectedEnvironmentConnectionGeneration,
              expectedEnvironmentPairingRevision,
              expectedTrackingGeneration,
              publishedSnapshotCount: event.snapshots.filter((snapshot) =>
                isHostMirroredWorktree(snapshot.worktree)
              ).length
            }
          },
          freshSnapshots
        )
        const freshSet = new Set(freshSnapshots)
        for (const { index, snapshot } of applicable) {
          if (unchanged[index]) {
            queueAcceptedWebSessionTerminalSnapshot(snapshot, environmentId)
          }
          if (unchanged[index] || freshSet.has(snapshot)) {
            coordinator.recordSnapshot(environmentId, snapshot, receivedFrames[index]!)
          }
        }
        coordinator.recordInventory(environmentId, visibilityGeneration, inventoryFrame, missing)
      })
      .catch((error) => {
        if (isCurrent()) {
          console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
        }
      })
      .finally(() => {
        for (const finishRecovery of finishRecoveries) {
          finishRecovery?.()
        }
        if (isCurrent()) {
          settleHydration?.()
        }
      })
    return
  }
  if (event.type !== 'snapshot' && event.type !== 'updated') {
    return
  }
  const receivedFrame = recordReceivedWebSessionTabsSnapshot(environmentId, event)
  coordinator.recordSnapshotReceipt(environmentId, event, receivedFrame)
  const finishRecovery = beginWebSessionTabsSnapshotRecovery(
    environmentId,
    event.worktree,
    receivedFrame
  )
  let settleHydration: HostSessionMirrorSettle | null = null
  void recoverWebSessionTerminalOrphansBeforeApply(useAppStore.getState(), event, environmentId)
    .then((recovered) => {
      if (
        !isCurrent() ||
        !recovered ||
        !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, recovered, receivedFrame) ||
        !coordinator.shouldApplySnapshot(environmentId, recovered, receivedFrame)
      ) {
        return
      }
      if (replayed) {
        acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
      }
      const decision = decideWebSessionTabsSnapshot(recovered, environmentId)
      if (decision.apply) {
        settleHydration = applyWebSessionTabsStorePatch(
          (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
          {
            frames: [
              {
                environmentId,
                worktreeId: recovered.worktree,
                decision,
                expectedEnvironmentConnectionGeneration,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration
              }
            ]
          },
          recovered,
          event.type === 'updated' && !replayed
        )
        coordinator.recordSnapshot(environmentId, recovered, receivedFrame)
      } else {
        settleHydration = hostSessionMirrorSettleForPatchlessFrame(
          decision,
          environmentId,
          recovered.worktree,
          {
            connectionGeneration: expectedEnvironmentConnectionGeneration,
            pairingRevision: expectedEnvironmentPairingRevision,
            trackingGeneration: expectedTrackingGeneration
          }
        )
      }
    })
    .catch((error) => {
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot recovery failed:', error)
      }
    })
    .finally(() => {
      finishRecovery()
      if (isCurrent()) {
        settleHydration?.()
      }
    })
}

function getLatestFreshness(
  key: string
): { publicationEpoch: string; snapshotVersion: number } | undefined {
  return latestSessionTabsSnapshotByWorktree.get(key)
}
function hasReplayAllowance(key: string): boolean {
  return replayableSessionTabsSnapshotByWorktree.has(key)
}
