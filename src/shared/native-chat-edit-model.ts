/** One rendered diff row. Numbers are per side: a removed row has no new-side
 *  number and an added row has no old-side number. */
export type NativeChatEditLineKind = 'context' | 'add' | 'del'

export type NativeChatEditLine = {
  kind: NativeChatEditLineKind
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export type NativeChatEditChangeKind = 'added' | 'deleted' | 'edited' | 'renamed'

export type NativeChatEditFile = {
  path: string
  /** Set only when the change moved the file. */
  oldPath: string | null
  changeKind: NativeChatEditChangeKind
  lines: NativeChatEditLine[]
  added: number
  removed: number
  /** False when the numbers locate a row inside a snippet rather than the file,
   *  which is the case whenever the provider gave us no resolved hunk ranges. */
  lineNumbersKnown: boolean
  truncated: boolean
}

export const MAX_EDIT_LINES = 2_000
export const MAX_EDIT_CHARS = 96_000
/** The LCS table is quadratic; above this a linear prefix/suffix diff is used. */
export const MAX_EDIT_DIFF_CELLS = 200_000

export function splitEditContent(content: string): string[] {
  if (content.length === 0) {
    return []
  }
  const lines = content.slice(0, MAX_EDIT_CHARS).split(/\r?\n/)
  if (content.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

/** Unified line numbering: a removed row is located on the old side, everything
 *  else on the new side. One column, so a replaced line repeats its number. */
export function unifiedLineNumber(line: NativeChatEditLine): number | null {
  return line.kind === 'del' ? line.oldLineNumber : (line.newLineNumber ?? line.oldLineNumber)
}

export function finalizeEditFile(
  input: Omit<NativeChatEditFile, 'added' | 'removed' | 'truncated'>
): NativeChatEditFile {
  const truncated = input.lines.length > MAX_EDIT_LINES
  const lines = truncated ? input.lines.slice(0, MAX_EDIT_LINES) : input.lines
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') {
      added += 1
    } else if (line.kind === 'del') {
      removed += 1
    }
  }
  return { ...input, lines, added, removed, truncated }
}
