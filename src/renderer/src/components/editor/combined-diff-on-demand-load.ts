export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

export function shouldLoadCombinedDiffOnDemand({
  added,
  removed
}: {
  added?: number
  removed?: number
}): boolean {
  // Untracked text files report additions only; both fields are absent when
  // line counts are unavailable (for example, binary or oversized files).
  if (added === undefined && removed === undefined) {
    return false
  }
  return (added ?? 0) + (removed ?? 0) > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
