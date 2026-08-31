import { hasBinaryFileExtension } from '../../../../shared/binary-file-extensions'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

export function shouldLoadCombinedDiffOnDemand({
  added,
  removed,
  path,
  area,
  submodule,
  hasCountedSiblings
}: {
  added?: number
  removed?: number
  path?: string
  area?: GitStatusEntry['area']
  submodule?: GitStatusEntry['submodule']
  // True when another row in the same status pass carried line counts, so
  // counting ran and this row is uncounted for a reason of its own.
  hasCountedSiblings?: boolean
}): boolean {
  if (added === undefined && removed === undefined) {
    // A submodule diffs to a "Subproject commit" line or two whatever it
    // contains, and numstat reports nothing at all for one whose only change is
    // untracked content inside it.
    if (submodule !== undefined || hasBinaryFileExtension(path)) {
      return false
    }
    // Counting ran for this pass, so a tracked row is uncounted only because
    // numstat called it binary ('-'). Untracked rows are also uncounted when
    // the scan skipped them past MAX_UNTRACKED_LINE_COUNT_BYTES, so those stay
    // deferred — their size is exactly what is unknown.
    if (hasCountedSiblings === true && area !== 'untracked') {
      return false
    }
    // Otherwise the size is unknown, not zero: an oversized untracked file, or
    // a status pass that skipped counting entirely (entry cap hit, numstat
    // failed). Defer everything Monaco would open as unbounded text.
    return true
  }
  return (added ?? 0) + (removed ?? 0) > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
