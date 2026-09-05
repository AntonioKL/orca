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

const GIT_DIFF_HEADER = 'diff --git '

export type UnifiedPatchSection = {
  /** Null when the patch text named no file, leaving it to the caller. */
  path: string | null
  oldPath: string | null
  changeKind: 'added' | 'deleted' | 'edited' | 'renamed'
  body: string
}

type Section = {
  rows: string[]
  oldPath: string | null
  newPath: string | null
  named: boolean
  /** A `--- `/`+++ ` pair already named this section, so the next one is a new file. */
  hasHeaderPair: boolean
}

/** Splits patch text into one section per file it touches. Without this a
 *  multi-file patch renders as a single card under the first file's name, with
 *  the later files' rows and gutter numbers beneath it. */
export function unifiedPatchSections(text: string): {
  sections: UnifiedPatchSection[]
  truncated: boolean
} {
  const source = splitEditContent(text)
  const rows = source.lines
  const sections: Section[] = []
  let current: Section | null = null
  let inHunk = false

  const open = (): Section => {
    const section: Section = {
      rows: [],
      oldPath: null,
      newPath: null,
      named: false,
      hasHeaderPair: false
    }
    sections.push(section)
    current = section
    return section
  }

  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index] ?? ''
    if (raw.startsWith(GIT_DIFF_HEADER)) {
      const paths = gitHeaderPaths(raw)
      const section = open()
      section.oldPath = paths.oldPath
      section.newPath = paths.newPath
      section.named = true
      inHunk = false
      continue
    }
    // The same rule the parser uses: a header pair is structure only outside a
    // hunk, where `--- ` would otherwise be a removed line beginning with `--`.
    if (!inHunk && isFileHeaderPair(rows, index)) {
      // The pair names the section a `diff --git` just opened; a second pair in
      // the same section is the next file of a patch written without them.
      const section = current && !current.hasHeaderPair ? current : open()
      section.oldPath = sourceHeaderPath(rows[index] ?? '')
      section.newPath = sourceHeaderPath(rows[index + 1] ?? '')
      section.named = true
      section.hasHeaderPair = true
      index += 1
      continue
    }
    if (raw.startsWith('@@')) {
      inHunk = true
    } else if (FILE_SECTION.test(raw)) {
      inHunk = false
    }
    ;(current ?? open()).rows.push(raw)
  }

  return {
    sections: sections.map((section) => ({
      path: section.newPath ?? section.oldPath,
      oldPath:
        section.oldPath && section.newPath && section.oldPath !== section.newPath
          ? section.oldPath
          : null,
      changeKind: sectionChangeKind(section),
      body: section.rows.join('\n')
    })),
    truncated: source.truncated
  }
}

function sectionChangeKind(section: Section): UnifiedPatchSection['changeKind'] {
  if (!section.named) {
    return 'edited'
  }
  if (section.newPath === null) {
    return 'deleted'
  }
  if (section.oldPath === null) {
    return 'added'
  }
  return section.oldPath === section.newPath ? 'edited' : 'renamed'
}

/** `--- a/<path>` / `+++ b/<path>`, where the absent side is `/dev/null` and a
 *  trailing tab introduces the timestamp some producers append. */
function sourceHeaderPath(line: string): string | null {
  const value = (line.slice(4).split('\t')[0] ?? '').trim()
  return value === '' || value === '/dev/null' ? null : value.replace(/^[ab]\//, '')
}

function gitHeaderPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice(GIT_DIFF_HEADER.length)
  // Both halves carry the same path unless the file moved, so the second one
  // starts at the last ` b/` rather than at the first space.
  const split = rest.lastIndexOf(' b/')
  if (split === -1) {
    return { oldPath: null, newPath: null }
  }
  return {
    oldPath: rest.slice(0, split).replace(/^a\//, ''),
    newPath: rest.slice(split + 1).replace(/^b\//, '')
  }
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
