export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

export function shouldLoadCombinedDiffOnDemand({
  added,
  removed
}: {
  added?: number
  removed?: number
}): boolean {
  if (added === undefined || removed === undefined) {
    return false
  }
  return added + removed > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
