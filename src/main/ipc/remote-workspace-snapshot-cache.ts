import { randomUUID } from 'node:crypto'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'

export const REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES = 64

type RemoteWorkspaceSnapshotCacheEntry = {
  snapshot: RemoteWorkspaceObservedSnapshot
  // Why: overlapping renderer writes retain their applied base until earlier same-client patches acknowledge.
  minimumAuthorizedRevision: number
  maximumAuthorizedRevision: number
}

const latestSnapshotByTargetId = new Map<string, RemoteWorkspaceSnapshotCacheEntry>()

function rememberRemoteWorkspaceSnapshotEntry(
  targetId: string,
  entry: RemoteWorkspaceSnapshotCacheEntry
): void {
  if (latestSnapshotByTargetId.has(targetId)) {
    latestSnapshotByTargetId.delete(targetId)
  }
  latestSnapshotByTargetId.set(targetId, entry)
  while (latestSnapshotByTargetId.size > REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = latestSnapshotByTargetId.keys().next()
    if (oldest.done) {
      break
    }
    latestSnapshotByTargetId.delete(oldest.value)
  }
}

export function rememberRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): RemoteWorkspaceObservedSnapshot {
  const observedSnapshot = { ...snapshot, hostObservationToken: randomUUID() }
  rememberRemoteWorkspaceSnapshotEntry(targetId, {
    snapshot: observedSnapshot,
    minimumAuthorizedRevision: snapshot.revision,
    maximumAuthorizedRevision: snapshot.revision
  })
  return observedSnapshot
}

export function rememberLocallyPatchedRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): RemoteWorkspaceObservedSnapshot {
  const current = latestSnapshotByTargetId.get(targetId)
  if (!current || snapshot.revision > current.maximumAuthorizedRevision + 1) {
    return rememberRemoteWorkspaceSnapshot(targetId, snapshot)
  }
  if (snapshot.revision < current.snapshot.revision) {
    rememberRemoteWorkspaceSnapshotEntry(targetId, current)
    return current.snapshot
  }
  const observedSnapshot = {
    ...snapshot,
    hostObservationToken: current.snapshot.hostObservationToken
  }
  rememberRemoteWorkspaceSnapshotEntry(targetId, {
    snapshot: observedSnapshot,
    minimumAuthorizedRevision: current.minimumAuthorizedRevision,
    maximumAuthorizedRevision: Math.max(current.maximumAuthorizedRevision, snapshot.revision)
  })
  return observedSnapshot
}

export function getCachedRemoteWorkspaceSnapshot(
  targetId: string
): RemoteWorkspaceObservedSnapshot | undefined {
  const entry = latestSnapshotByTargetId.get(targetId)
  if (!entry) {
    return undefined
  }
  // Why: remote workspace snapshots can contain the whole tab/layout session
  // for a target. Touch cache hits so deleted or rarely used targets age out.
  rememberRemoteWorkspaceSnapshotEntry(targetId, entry)
  return entry.snapshot
}

export function cachedRemoteWorkspaceSnapshotAuthorizesRevision(
  targetId: string,
  revision: number
): boolean {
  const entry = latestSnapshotByTargetId.get(targetId)
  return (
    entry !== undefined &&
    revision >= entry.minimumAuthorizedRevision &&
    revision <= entry.maximumAuthorizedRevision
  )
}

export function clearRemoteWorkspaceSnapshotCache(): void {
  latestSnapshotByTargetId.clear()
}

export function getRemoteWorkspaceSnapshotCacheSize(): number {
  return latestSnapshotByTargetId.size
}

/** @internal - exposed for cache-bound tests only. */
export function _rememberRemoteWorkspaceSnapshotForTests(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): void {
  rememberRemoteWorkspaceSnapshot(targetId, snapshot)
}

/** @internal - exposed for cache-bound tests only. */
export function _getRemoteWorkspaceSnapshotForTests(
  targetId: string
): RemoteWorkspaceObservedSnapshot | undefined {
  return getCachedRemoteWorkspaceSnapshot(targetId)
}
