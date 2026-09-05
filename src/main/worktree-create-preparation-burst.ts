import { setBoundedMapEntry } from './runtime/runtime-async-boundaries'

/** Two creates this close together mean more are likely; an isolated create earns no replacement. */
export const WORKTREE_CREATE_BURST_MS = 5 * 60_000
const WORKTREE_CREATE_PREPARATION_CREATE_MAX = 64

/** When each preparation key was last created from, so a burst can be told from an isolated create. */
const lastCreatedAt = new Map<string, number>()

/** Records this create and reports whether it continues a burst. A replacement checkout costs a
 *  full tree and holds disk until its TTL, so only a user who is already creating repeatedly earns
 *  one; the first create of a session pays nothing for a spare nobody claims. */
export function recordPreparationCreate(key: string, now = Date.now()): boolean {
  const previous = lastCreatedAt.get(key)
  setBoundedMapEntry(lastCreatedAt, key, now, WORKTREE_CREATE_PREPARATION_CREATE_MAX)
  return previous !== undefined && now - previous <= WORKTREE_CREATE_BURST_MS
}

export function resetPreparationCreateHistoryForTests(): void {
  lastCreatedAt.clear()
}
