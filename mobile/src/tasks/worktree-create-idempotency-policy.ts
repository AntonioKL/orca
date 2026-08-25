// Why: old idempotent hosts omit policy; this fallback also caps advertisements
// so a new host cannot widen a deployed client's replay behavior.
export const WORKTREE_CREATE_DEDUPE_TTL_FALLBACK_MS = 60_000

// Why: the replay still has to reach the host before its dedupe record expires.
const WORKTREE_CREATE_REPLAY_FLIGHT_MARGIN_MS = 10_000

export type WorktreeCreateIdempotencySupport = {
  dedupeTtlMs: number
}

export type WorktreeCreateIdempotencyProbe =
  | WorktreeCreateIdempotencySupport
  | false
  | Promise<WorktreeCreateIdempotencySupport | false>

export function resolveWorktreeCreateIdempotencySupport(
  advertisedDedupeTtlMs: unknown
): WorktreeCreateIdempotencySupport {
  if (advertisedDedupeTtlMs === undefined) {
    return { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_FALLBACK_MS }
  }
  if (
    typeof advertisedDedupeTtlMs !== 'number' ||
    !Number.isSafeInteger(advertisedDedupeTtlMs) ||
    advertisedDedupeTtlMs < 0
  ) {
    return { dedupeTtlMs: 0 }
  }
  return {
    dedupeTtlMs: Math.min(advertisedDedupeTtlMs, WORKTREE_CREATE_DEDUPE_TTL_FALLBACK_MS)
  }
}

export function getWorktreeCreateReplayWindowMs(support: WorktreeCreateIdempotencySupport): number {
  if (!Number.isSafeInteger(support.dedupeTtlMs) || support.dedupeTtlMs <= 0) {
    return 0
  }
  return Math.max(
    0,
    Math.min(support.dedupeTtlMs, WORKTREE_CREATE_DEDUPE_TTL_FALLBACK_MS) -
      WORKTREE_CREATE_REPLAY_FLIGHT_MARGIN_MS
  )
}
