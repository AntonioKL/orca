import { MAX_EDIT_CHARS, type NativeChatEditLine } from './native-chat-edit-model'

const HUNK_RANGES = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** Structural lines that open a file section, so any hunk before them has ended. */
const FILE_SECTION =
  /^(?:diff |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename |copy |Binary files |--- |\+\+\+ |\\ No newline)/

export type UnifiedPatchLines = {
  lines: NativeChatEditLine[]
  /** True only when every hunk carried real `@@` ranges. */
  lineNumbersKnown: boolean
}

/** Parses unified patch text, keeping the `@@` ranges as per-row line numbers.
 *  Codex writes hunk headers whose `@@` is a bare context anchor with no
 *  ranges; those rows are emitted without numbers rather than numbered from 1,
 *  because a wrong number reads as authoritative. */
export function editLinesFromUnifiedPatch(text: string): UnifiedPatchLines | null {
  const source = text.length > MAX_EDIT_CHARS ? text.slice(0, MAX_EDIT_CHARS) : text
  const lines: NativeChatEditLine[] = []
  let oldNo: number | null = null
  let newNo: number | null = null
  let sawHunk = false
  let ranged = true
  let inHunk = false

  for (const raw of source.split('\n')) {
    if (raw.startsWith('@@')) {
      const match = HUNK_RANGES.exec(raw)
      if (match) {
        oldNo = Number(match[1])
        newNo = Number(match[3])
      } else {
        oldNo = null
        newNo = null
        ranged = false
      }
      sawHunk = true
      inHunk = true
      continue
    }
    if (!inHunk || FILE_SECTION.test(raw)) {
      inHunk = inHunk && !FILE_SECTION.test(raw)
      continue
    }
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
  // Trailing blank from a patch that ended with a newline reads as a phantom row.
  if (lines.at(-1)?.kind === 'context' && lines.at(-1)?.text === '') {
    lines.pop()
  }
  return { lines, lineNumbersKnown: ranged }
}

/** Rows for a whole-file add or delete, which legitimately number from 1. */
export function editLinesFromWholeFile(content: string, kind: 'add' | 'del'): NativeChatEditLine[] {
  const body = content.length > MAX_EDIT_CHARS ? content.slice(0, MAX_EDIT_CHARS) : content
  const rows = body.split('\n')
  if (rows.at(-1) === '') {
    rows.pop()
  }
  return rows.map((text, index) => ({
    kind,
    text,
    oldLineNumber: kind === 'del' ? index + 1 : null,
    newLineNumber: kind === 'add' ? index + 1 : null
  }))
}
