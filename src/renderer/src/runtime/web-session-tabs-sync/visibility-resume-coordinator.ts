import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  advancesSessionTabsFreshness,
  shouldApplyRecoveredWebSessionTabsSnapshot,
  sessionTabsFreshnessKey
} from './tracking'
import { latestSessionTabsSnapshotByWorktree, sessionTabsEnvironmentsByWorktree } from './state'
import { acceptReplayedWebSessionTabsSnapshot } from './tracking-lifecycle'
import {
  applyWebSessionTabsSnapshotOperations,
  decideWebSessionTabsSnapshotOperations,
  type WebSessionTabsSnapshotOperation
} from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'
import {
  recordVisibilityResumeInventory,
  recordVisibilityResumeInventoryReceipt
} from './visibility-resume-inventory'
import type { VisibilityResumeOmission } from './state'
import type {
  MirroredRuntimeEnvironment,
  VisibilityResumeBatch,
  VisibilityResumeMissing
} from './visibility-resume-types'
import { buildVisibilityResumeBatch } from './visibility-resume-batch'

export type VisibilityResumeCoordinatorOptions = {
  environments: readonly MirroredRuntimeEnvironment[]
  environmentIdBySubscriptionSpec: readonly string[]
  omissions: Map<string, VisibilityResumeOmission>
  activeRuntimeWorktreeKey: () => string | null
}

/** Coordinates inventory omissions and cross-environment replay during visibility resumes. */
export class VisibilityResumeCoordinator {
  private batch: VisibilityResumeBatch | null = null

  constructor(private readonly options: VisibilityResumeCoordinatorOptions) {}

  recordSnapshotReceipt(
    environmentId: string,
    snapshot: RuntimeMobileSessionTabsResult,
    receivedFrame: number
  ): void {
    const omission = this.options.omissions.get(
      sessionTabsFreshnessKey(environmentId, snapshot.worktree)
    )
    if (
      omission &&
      receivedFrame > omission.inventoryReceivedFrame &&
      ((snapshot as { removed?: unknown }).removed === true ||
        advancesSessionTabsFreshness(snapshot, omission.baseline))
    ) {
      omission.superseded = true
      if (this.batch?.pendingMissingByWorktree.has(snapshot.worktree)) {
        this.reconcileWorktrees([snapshot.worktree])
      }
    }
  }

  shouldApplySnapshot(
    environmentId: string,
    snapshot: RuntimeMobileSessionTabsResult,
    receivedFrame: number
  ): boolean {
    const omission = this.options.omissions.get(
      sessionTabsFreshnessKey(environmentId, snapshot.worktree)
    )
    if (!omission) {
      return true
    }
    if (receivedFrame < omission.inventoryReceivedFrame) {
      return false
    }
    return (
      (snapshot as { removed?: unknown }).removed === true ||
      advancesSessionTabsFreshness(snapshot, omission.baseline)
    )
  }

  private missingCurrent(missing: VisibilityResumeMissing): boolean {
    const omission = this.options.omissions.get(
      sessionTabsFreshnessKey(missing.environmentId, missing.snapshot.worktree)
    )
    return (
      omission?.inventoryReceivedFrame === missing.inventoryReceivedFrame && !omission.superseded
    )
  }

  private replayableSnapshot(
    batch: VisibilityResumeBatch,
    environmentId: string,
    worktreeId: string
  ): RuntimeMobileSessionTabsResult | null {
    const key = sessionTabsFreshnessKey(environmentId, worktreeId)
    const entry = batch.reapplyableSnapshotsByKey.get(key)
    const freshness = entry ? latestSessionTabsSnapshotByWorktree.get(key) : undefined
    if (
      !entry ||
      !freshness ||
      freshness.publicationEpoch !== entry.snapshot.publicationEpoch ||
      freshness.snapshotVersion !== entry.snapshot.snapshotVersion ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(
        environmentId,
        entry.snapshot,
        entry.receivedFrame
      )
    ) {
      return null
    }
    return entry.snapshot
  }

  private finishIfIdle(batch: VisibilityResumeBatch): void {
    if (
      batch.pendingInventoryCount === 0 &&
      batch.pendingMissingByWorktree.size === 0 &&
      this.batch === batch
    ) {
      this.batch = null
    }
  }

  private reconcileWorktrees(worktreeIds: Iterable<string>): void {
    const batch = this.batch
    if (!batch) {
      return
    }
    const operations: WebSessionTabsSnapshotOperation[] = []
    for (const worktreeId of new Set(worktreeIds)) {
      const pendingMissing = batch.pendingMissingByWorktree.get(worktreeId)
      if (!pendingMissing) {
        batch.deferredRepairWorktrees.delete(worktreeId)
        continue
      }
      for (const [environmentId, missing] of pendingMissing) {
        if (this.missingCurrent(missing)) {
          continue
        }
        pendingMissing.delete(environmentId)
        batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
      }
      if (pendingMissing.size === 0) {
        batch.pendingMissingByWorktree.delete(worktreeId)
        batch.deferredRepairWorktrees.delete(worktreeId)
        continue
      }
      const missingEnvironmentIds = new Set(pendingMissing.keys())
      const survivingSnapshots: {
        environmentId: string
        snapshot: RuntimeMobileSessionTabsResult
      }[] = []
      let canRepair = true
      for (const environmentId of sessionTabsEnvironmentsByWorktree.get(worktreeId) ?? []) {
        if (missingEnvironmentIds.has(environmentId)) {
          continue
        }
        const snapshot = this.replayableSnapshot(batch, environmentId, worktreeId)
        if (!snapshot) {
          canRepair = false
          break
        }
        survivingSnapshots.push({ environmentId, snapshot })
      }
      if (!canRepair) {
        batch.deferredRepairWorktrees.add(worktreeId)
        continue
      }
      for (const missing of pendingMissing.values()) {
        operations.push({ environmentId: missing.environmentId, snapshot: missing.snapshot })
      }
      for (const { environmentId, snapshot } of survivingSnapshots) {
        acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
        operations.push({ environmentId, snapshot })
      }
      for (const environmentId of pendingMissing.keys()) {
        batch.environments.get(environmentId)?.pendingMissingWorktrees.delete(worktreeId)
      }
      batch.pendingMissingByWorktree.delete(worktreeId)
      batch.deferredRepairWorktrees.delete(worktreeId)
    }
    if (operations.length > 0) {
      const decided = decideWebSessionTabsSnapshotOperations(operations)
      const settle = applyWebSessionTabsStorePatch(
        (state) => applyWebSessionTabsSnapshotOperations(state, decided),
        {
          frames: decided.map(({ environmentId, snapshot, decision }) => ({
            environmentId,
            worktreeId: snapshot.worktree,
            decision,
            expectedEnvironmentConnectionGeneration:
              batch.environments.get(environmentId)?.expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision:
              batch.environments.get(environmentId)?.expectedEnvironmentPairingRevision,
            expectedTrackingGeneration:
              batch.environments.get(environmentId)?.expectedTrackingGeneration
          }))
        },
        operations.map(({ snapshot }) => snapshot)
      )
      settle()
    }
    this.finishIfIdle(batch)
  }

  recordSnapshot(
    environmentId: string,
    snapshot: RuntimeMobileSessionTabsResult,
    receivedFrame: number
  ): void {
    const batch = this.batch
    if (!batch || !batch.trackedWorktreeIds.has(snapshot.worktree)) {
      return
    }
    const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
    const existing = this.replayableSnapshot(batch, environmentId, snapshot.worktree)
    const freshness = latestSessionTabsSnapshotByWorktree.get(key)
    const crossHost =
      (sessionTabsEnvironmentsByWorktree.get(snapshot.worktree)?.size ?? 0) > 1 ||
      batch.deferredRepairWorktrees.has(snapshot.worktree)
    if (
      (snapshot as { removed?: unknown }).removed === true ||
      snapshot.tabs.length === 0 ||
      !crossHost ||
      freshness?.publicationEpoch !== snapshot.publicationEpoch ||
      freshness.snapshotVersion !== snapshot.snapshotVersion ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, snapshot, receivedFrame)
    ) {
      if (!existing) {
        batch.reapplyableSnapshotsByKey.delete(key)
      }
    } else {
      batch.reapplyableSnapshotsByKey.set(key, { snapshot, receivedFrame })
    }
    if (batch.pendingMissingByWorktree.has(snapshot.worktree)) {
      this.reconcileWorktrees([snapshot.worktree])
    }
  }

  recordInventory(
    environmentId: string,
    visibilityGeneration: number,
    inventoryReceivedFrame: number,
    missingWorktrees: readonly VisibilityResumeMissing[]
  ): void {
    recordVisibilityResumeInventory({
      batch: this.batch,
      environmentId,
      visibilityGeneration,
      inventoryReceivedFrame,
      missingWorktrees,
      reconcileWorktrees: (worktreeIds) => this.reconcileWorktrees(worktreeIds)
    })
  }

  recordInventoryReceipt(
    environmentId: string,
    visibilityGeneration: number,
    inventoryReceivedFrame: number,
    snapshots: readonly RuntimeMobileSessionTabsResult[]
  ): VisibilityResumeMissing[] {
    return recordVisibilityResumeInventoryReceipt({
      batch: this.batch,
      omissions: this.options.omissions,
      environmentId,
      visibilityGeneration,
      inventoryReceivedFrame,
      snapshots
    })
  }

  beginVisibilityResume(
    visibilityGeneration: number,
    restartingSpecIndexes: readonly number[]
  ): void {
    this.batch = buildVisibilityResumeBatch({
      visibilityGeneration,
      restartingSpecIndexes,
      environmentIdBySubscriptionSpec: this.options.environmentIdBySubscriptionSpec,
      environments: this.options.environments,
      omissions: this.options.omissions,
      activeRuntimeWorktreeKey: this.options.activeRuntimeWorktreeKey
    })
  }
}
