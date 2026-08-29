import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'

/**
 * When each listed row was read, keyed by candidate identity.
 *
 * Why this exists rather than another comparison against `scannedAt`: recency is a
 * property of a ROW, and `scannedAt` is a property of a SCAN. The two stop agreeing
 * the moment the list holds rows from more than one read — which is exactly what a
 * post-confirmation republish does, and it leaves the scan still reporting the older
 * read's time while showing the newer read's row. A targeted rescan is also dated by
 * its stalest chunk, so it is not even measured on the same basis as a broad scan's
 * single stamp. Stamping the row is what lets "the most recent read wins" hold for
 * every writer instead of only the one that happens to compare.
 */
export type WorkspaceCleanupRowReads = Record<string, number>

export function recordWorkspaceCleanupRowReads(
  previous: WorkspaceCleanupRowReads,
  rows: readonly WorkspaceCleanupCandidate[],
  readAt: number,
  retiredIdentities: ReadonlySet<string> = new Set()
): WorkspaceCleanupRowReads {
  const next = { ...previous }
  for (const identity of retiredIdentities) {
    delete next[identity]
  }
  for (const row of rows) {
    next[getWorkspaceCleanupCandidateIdentity(row)] = readAt
  }
  return next
}

/**
 * Keep any listed row whose recorded read is newer than the incoming one.
 *
 * The incoming rows are a whole-list replacement, so without this a refresh issued
 * before a confirmation lands after the refusal and erases the blocker the user has
 * not seen yet — leaving them to reconfirm against the picture already refused.
 */
export function preserveNewerWorkspaceCleanupRows(
  incoming: readonly WorkspaceCleanupCandidate[],
  incomingReadAt: number,
  listed: readonly WorkspaceCleanupCandidate[],
  rowReads: WorkspaceCleanupRowReads
): WorkspaceCleanupCandidate[] {
  const newerListedRows = new Map<string, WorkspaceCleanupCandidate>()
  for (const row of listed) {
    const identity = getWorkspaceCleanupCandidateIdentity(row)
    const readAt = rowReads[identity]
    if (readAt !== undefined && readAt > incomingReadAt) {
      newerListedRows.set(identity, row)
    }
  }
  if (newerListedRows.size === 0) {
    return incoming as WorkspaceCleanupCandidate[]
  }
  return incoming.map(
    (row) => newerListedRows.get(getWorkspaceCleanupCandidateIdentity(row)) ?? row
  )
}

/** Reads for rows no longer listed are dead weight, and a later row could inherit one. */
export function pruneWorkspaceCleanupRowReads(
  rowReads: WorkspaceCleanupRowReads,
  rows: readonly WorkspaceCleanupCandidate[]
): WorkspaceCleanupRowReads {
  const listedIdentities = new Set(rows.map(getWorkspaceCleanupCandidateIdentity))
  const entries = Object.entries(rowReads).filter(([identity]) => listedIdentities.has(identity))
  return entries.length === Object.keys(rowReads).length ? rowReads : Object.fromEntries(entries)
}
