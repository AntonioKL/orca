import { isFileHeaderPair } from './native-chat-diff'
import { pushEditGap, splitEditContent, type NativeChatEditLine } from './native-chat-edit-model'

const HUNK_RANGES = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** Structural lines that open a file section, so any hunk before them has ended.
 *  `--- `/`+++ ` are deliberately absent: inside a hunk they are content — a
 *  removed `-- comment` is emitted as `--- comment` — so they go through
 *  `isFileHeaderPair` instead. */
const FILE_SECTION =
  /^(?:diff |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename |copy |Binary files )/

export type UnifiedPatchLines = {
  lines: NativeChatEditLine[]
  /** True only when every hunk carried real `@@` ranges. */
  lineNumbersKnown: boolean
  /** The patch text was clipped before it became rows. */
  truncated: boolean
}

/** Parses unified patch text, keeping the `@@` ranges as per-row line numbers.
 *  A hunk header whose `@@` is a bare context anchor with no ranges leaves its
 *  rows unnumbered rather than numbered from 1, because a wrong number reads as
 *  authoritative.
 *
 *  `implicitFirstHunk` opens the body as a hunk of unknown position, for the
 *  patch dialect whose first chunk may carry no header at all. */
export function editLinesFromUnifiedPatch(
  text: string,
  options?: { implicitFirstHunk?: boolean }
): UnifiedPatchLines | null {
  const source = splitEditContent(text)
  const rows = source.lines
  const lines: NativeChatEditLine[] = []
  let oldNo: number | null = null
  let newNo: number | null = null
  let sawHunk = options?.implicitFirstHunk === true
  let ranged = true
  let inHunk = sawHunk

  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index] ?? ''
    if (raw.startsWith('@@')) {
      const match = HUNK_RANGES.exec(raw)
      oldNo = match ? Number(match[1]) : null
      newNo = match ? Number(match[3]) : null
      // Successive hunks are separate regions of the file; concatenated with no
      // break the gutter jumps and the reader sees one continuous block.
      pushEditGap(lines)
      sawHunk = true
      inHunk = true
      continue
    }
    // `\ No newline at end of file` sits mid-hunk, between the removed old last
    // line and the added new one, so it ends nothing.
    if (raw.startsWith('\\')) {
      continue
    }
    if (!inHunk && isFileHeaderPair(rows, index)) {
      index += 1
      continue
    }
    if (FILE_SECTION.test(raw)) {
      inHunk = false
      continue
    }
    if (!inHunk) {
      continue
    }
    // Read off the rows rather than the header, so a body that opened with no
    // header is reported as unlocatable just like a rangeless `@@`.
    ranged &&= oldNo !== null || newNo !== null
    if (raw.startsWith('+')) {
      lines.push({
        kind: 'add',
        text: raw.slice(1),
        oldLineNumber: null,
        newLineNumber: newNo
      })
      newNo = newNo === null ? null : newNo + 1
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({
        kind: 'del',
        text: raw.slice(1),
        oldLineNumber: oldNo,
        newLineNumber: null
      })
      oldNo = oldNo === null ? null : oldNo + 1
      continue
    }
    lines.push({
      kind: 'context',
      text: raw.startsWith(' ') ? raw.slice(1) : raw,
      oldLineNumber: oldNo,
      newLineNumber: newNo
    })
    oldNo = oldNo === null ? null : oldNo + 1
    newNo = newNo === null ? null : newNo + 1
  }

  if (!sawHunk || lines.length === 0) {
    return null
  }
  return { lines, lineNumbersKnown: ranged, truncated: source.truncated }
}

/** Rows for a whole-file add or delete, which legitimately number from 1. */
export function editLinesFromWholeFile(
  content: string,
  kind: 'add' | 'del'
): { lines: NativeChatEditLine[]; truncated: boolean } {
  const body = splitEditContent(content)
  return {
    lines: body.lines.map((text, index) => ({
      kind,
      text,
      oldLineNumber: kind === 'del' ? index + 1 : null,
      newLineNumber: kind === 'add' ? index + 1 : null
    })),
    truncated: body.truncated
  }
}
