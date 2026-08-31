import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DaemonPtyCheckpointScheduler } from './daemon-pty-checkpoint-scheduler'
import type { SnapshotCheckpointResult } from './daemon-pty-runtime-state'
import type { TerminalHistoryLogBatch } from './terminal-history-log'
import type { GetSnapshotResult, PendingOutputRecord, TakePendingOutputResult } from './types'

// Why 4MB: double the daemon's 2MB pending-output cap; a carry can only exceed it when the
// invariant that no new takes drain while a full checkpoint is owed has broken, so re-anchor live.
const MAX_CARRIED_UNLOGGED_CHARS = 4 * 1024 * 1024

export abstract class DaemonPtyCheckpointPersistence extends DaemonPtyCheckpointScheduler {
  // Why 'deferred' exists: a full snapshot inside the cooldown is postponed and the session stays dirty for retry;
  // skipping append meanwhile keeps the on-disk log a consistent (stale) prefix instead of punching a hole.
  protected async writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'> {
    if (!this.supportsIncrementalCheckpoints) {
      const result = await this.client.request<GetSnapshotResult>('getSnapshot', { sessionId })
      if (result.snapshot && this.historyManager) {
        const checkpoint = await this.historyManager.checkpoint(sessionId, result.snapshot)
        return checkpoint === 'retryable' ? 'deferred' : 'done'
      }
      return 'done'
    }
    if (opts.final || this.sessionsNeedingFullCheckpoint.has(sessionId)) {
      if (!opts.final && this.isFullCheckpointCoolingDown(sessionId)) {
        return 'deferred'
      }
      // Why take-with-snapshot not plain getSnapshot: it clears pending records in the same turn as the serialize,
      // so a warm reattach won't re-append records the checkpoint already contains (double-replay on cold restore).
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: opts.teardown,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId),
        requireContinuityProof: this.sessionsNeedingContinuityCheckpoint.has(sessionId)
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      this.sessionsNeedingFullCheckpoint.delete(sessionId)
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return 'done'
    }
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId
    })
    if (!take) {
      return 'done'
    }
    if (take.overflowed) {
      // Why: overflow dropped records (log has a hole); only a full snapshot can re-anchor it.
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        // Why live: the dropped bytes are unrecoverable, so the deferred retry must not
        // durable-rebuild from disk and splice over the hole.
        this.sessionsNeedingLiveCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: true
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      return 'done'
    }
    if (take.records.length === 0) {
      return 'done'
    }
    if (!this.historyManager) {
      return 'done'
    }
    const appendResult = await this.historyManager.appendIncrements(
      sessionId,
      take.seq,
      take.records
    )
    if (appendResult === 'needs-checkpoint') {
      // Why carry, not drop: the capped log is intact, so the rotation can keep the full durable
      // depth — but this drained batch is in no other durable source; the rebuild needs it (#17114).
      this.carryUnloggedBatch(sessionId, take.seq, take.records)
      if (this.isFullCheckpointCoolingDown(sessionId)) {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
      const checkpoint = await this.takeSnapshotAndCheckpoint(sessionId, {
        teardown: false,
        forceLiveSnapshot: this.sessionsNeedingLiveCheckpoint.has(sessionId)
      })
      if (checkpoint.checkpoint === 'retryable') {
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        return 'deferred'
      }
    }
    return 'done'
  }

  // Why a seq-tagged carry: the rebuild must prove the carried batches continue the on-disk log
  // exactly, or fall back to the live window rather than splice output over an undetected gap.
  protected carryUnloggedBatch(
    sessionId: string,
    seq: number,
    records: PendingOutputRecord[]
  ): void {
    const carried = this.carriedUnloggedBatchesBySessionId.get(sessionId) ?? []
    const last = carried.at(-1)
    if (last && last.seq + 1 !== seq) {
      this.dropCarryAndReanchorLive(sessionId)
      return
    }
    carried.push({ seq, records })
    let carriedChars = 0
    for (const batch of carried) {
      for (const record of batch.records) {
        carriedChars += record.kind === 'output' ? record.data.length : 8
      }
    }
    if (carriedChars > MAX_CARRIED_UNLOGGED_CHARS) {
      this.dropCarryAndReanchorLive(sessionId)
      return
    }
    this.carriedUnloggedBatchesBySessionId.set(sessionId, carried)
  }

  private dropCarryAndReanchorLive(sessionId: string): void {
    this.carriedUnloggedBatchesBySessionId.delete(sessionId)
    this.sessionsNeedingLiveCheckpoint.add(sessionId)
  }

  /** Consumes the carry; null means it does not continue `takeSeq` and the caller must go live. */
  private consumeCarriedUnloggedBatches(
    sessionId: string,
    takeSeq: number
  ): TerminalHistoryLogBatch[] | null {
    const carried = this.carriedUnloggedBatchesBySessionId.get(sessionId)
    if (!carried) {
      return []
    }
    this.carriedUnloggedBatchesBySessionId.delete(sessionId)
    return carried.at(-1)!.seq + 1 === takeSeq ? carried : null
  }

  protected async takeSnapshotAndCheckpoint(
    sessionId: string,
    opts: {
      teardown: boolean
      forceLiveSnapshot?: boolean
      requireContinuityProof?: boolean
    }
  ): Promise<SnapshotCheckpointResult> {
    const take = await this.client.request<TakePendingOutputResult | null>('takePendingOutput', {
      sessionId,
      includeSnapshot: true,
      teardownSnapshot: opts.teardown
    })
    if (take?.snapshot && this.historyManager) {
      // Carried batches are consumed on every outcome: any commit contains their bytes (the
      // emulator already applied them), and every failure path retries as a live re-anchor.
      const carried = this.consumeCarriedUnloggedBatches(sessionId, take.seq)
      const firstPendingSeq = carried?.[0]?.seq ?? take.seq
      // Why require drainedRecords: an older daemon still empties the pending
      // queue on includeSnapshot but omits the field. Treating absence as []
      // would compact stale disk history and reset the log.
      const snapshot =
        take.drainedRecords === undefined ||
        opts.forceLiveSnapshot === true ||
        take.overflowed ||
        carried === null
          ? take.snapshot
          : await this.buildDurableHistorySnapshot(
              sessionId,
              take.snapshot,
              [
                ...carried.flatMap((batch) => batch.records),
                ...take.drainedRecords,
                ...take.records
              ],
              {
                pendingRecordsAreComplete: firstPendingSeq === 1,
                ...(opts.requireContinuityProof === true
                  ? { requiredPreviousPendingOutputSeq: firstPendingSeq - 1 }
                  : {})
              }
            )
      const checkpoint = await this.historyManager.checkpoint(sessionId, snapshot, {
        pendingOutputSeq: take.seq
      })
      if (checkpoint === 'retryable') {
        // Why take.records is dropped, not appended: the pending output this take drained went into the snapshot that
        // failed to land, so appending the held tail at the next contiguous seq would splice it over that hole and
        // defeat the log's seq-gap detection. A stale prefix beats an undetectable hole.
        this.sessionsNeedingFullCheckpoint.add(sessionId)
        this.sessionsNeedingLiveCheckpoint.add(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        this.markSessionDirty(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      if (checkpoint === 'unavailable') {
        this.sessionsNeedingFullCheckpoint.delete(sessionId)
        this.sessionsNeedingLiveCheckpoint.delete(sessionId)
        this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
        return { checkpoint, snapshot: take.snapshot }
      }
      this.lastFullCheckpointAt.set(sessionId, Date.now())
      if (take.records.length > 0 && snapshot === take.snapshot) {
        // Why: live-window fallback still lacks held parser-state bytes; keep them as a post-checkpoint log tail.
        await this.historyManager.appendIncrements(sessionId, take.seq, take.records)
      }
      this.sessionsNeedingLiveCheckpoint.delete(sessionId)
      this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
      return { checkpoint: 'committed', snapshot }
    }
    this.sessionsNeedingFullCheckpoint.delete(sessionId)
    this.sessionsNeedingLiveCheckpoint.delete(sessionId)
    this.sessionsNeedingContinuityCheckpoint.delete(sessionId)
    this.carriedUnloggedBatchesBySessionId.delete(sessionId)
    return { checkpoint: 'unavailable', snapshot: take?.snapshot ?? null }
  }

  protected async buildDurableHistorySnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<TakePendingOutputResult['snapshot']>,
    pendingRecords: TakePendingOutputResult['records'],
    opts: {
      pendingRecordsAreComplete: boolean
      requiredPreviousPendingOutputSeq?: number
    }
  ): Promise<NonNullable<TakePendingOutputResult['snapshot']>> {
    if (!this.historyReader) {
      return liveSnapshot
    }
    try {
      const restoreInfo = await this.historyReader.detectColdRestore(sessionId, {
        ignoreCleanEnd: true,
        wslDistro: this.wslDistrosBySessionId.get(sessionId)
      })
      if (
        (!restoreInfo && !opts.pendingRecordsAreComplete) ||
        (opts.requiredPreviousPendingOutputSeq !== undefined &&
          restoreInfo?.pendingOutputSeq !== opts.requiredPreviousPendingOutputSeq)
      ) {
        console.warn('[history] durable continuity unproven; using live snapshot:', sessionId)
        return liveSnapshot
      }
      return await buildDurableCheckpointSnapshot({
        liveSnapshot,
        restoreInfo,
        pendingRecords
      })
    } catch (error) {
      console.warn('[history] durable history rebuild failed:', sessionId, error)
      return liveSnapshot
    }
  }
}
