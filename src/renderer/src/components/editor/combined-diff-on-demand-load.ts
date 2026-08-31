import { hasBinaryFileExtension } from '../../../../shared/binary-file-extensions'

export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

export function shouldLoadCombinedDiffOnDemand({
  added,
  removed,
  path
}: {
  added?: number
  removed?: number
  path?: string
}): boolean {
  if (added === undefined && removed === undefined) {
    // A row with no counts is one of: a binary file (git numstat reports '-',
    // and the untracked scan skips binaries), an untracked file past the scan's
    // size cap (MAX_UNTRACKED_LINE_COUNT_BYTES), or any file in a status pass
    // that skipped counting entirely (entry cap hit, numstat failed). Only the
    // binary case is cheap to render, and only the path can tell us that here,
    // so defer everything Monaco would open as unbounded text.
    return !hasBinaryFileExtension(path)
  }
  return (added ?? 0) + (removed ?? 0) > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
