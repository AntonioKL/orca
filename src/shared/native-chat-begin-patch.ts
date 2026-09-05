import { finalizeEditFile, type NativeChatEditFile } from './native-chat-edit-model'
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from './native-chat-unified-patch'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/
/** Envelope structure that carries no file content of its own. */
const CONTROL_LINE = /^\*\*\* (?:End of File|Environment ID:)/

/** The envelope reaches a tool call as one of its argument values, either whole
 *  or as an element of the argument vector the agent runs. Recover its text. */
export function unwrapBeginPatch(input: unknown): string | null {
  const source =
    typeof input === 'string'
      ? input
      : typeof input === 'object' && input !== null
        ? envelopeArgument(input as Record<string, unknown>)
        : null
  if (!source) {
    return null
  }
  const start = source.indexOf(BEGIN)
  if (start === -1) {
    return null
  }
  const end = source.indexOf(END, start)
  if (end === -1) {
    // Without the closing marker there is nothing separating the patch body from
    // whatever the command line continues with, and trailing shell syntax would
    // render as file content the agent never wrote.
    return null
  }
  return source.slice(start, end + END.length)
}

/** Any argument value may hold the envelope, including one word of an argument
 *  vector, so look at the values rather than guessing at key names. */
function envelopeArgument(record: Record<string, unknown>): string | null {
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.includes(BEGIN)) {
      return value
    }
    if (Array.isArray(value)) {
      const word = value.find(
        (entry): entry is string => typeof entry === 'string' && entry.includes(BEGIN)
      )
      if (word) {
        return word
      }
    }
  }
  return null
}

/** Splits a `*** Begin Patch` envelope into one entry per file it touches. */
export function editFilesFromBeginPatch(envelope: string): NativeChatEditFile[] {
  const sections: { kind: 'Add' | 'Update' | 'Delete'; path: string; body: string[] }[] = []
  let movePath: string | null = null
  const moves = new Map<number, string>()

  // Split on both newline forms once, so every marker below can be matched
  // exactly rather than each pattern having to tolerate a trailing `\r`.
  for (const raw of envelope.split(/\r?\n/)) {
    const header = FILE_HEADER.exec(raw)
    if (header) {
      sections.push({
        kind: header[1] as 'Add' | 'Update' | 'Delete',
        path: header[2]!.trim(),
        body: []
      })
      continue
    }
    const move = MOVE_HEADER.exec(raw)
    if (move && sections.length > 0) {
      movePath = move[1]!.trim()
      moves.set(sections.length - 1, movePath)
      continue
    }
    if (raw === BEGIN || raw === END || CONTROL_LINE.test(raw) || sections.length === 0) {
      continue
    }
    sections.at(-1)!.body.push(raw)
  }

  return sections.flatMap((section, index) => {
    const body = section.body.join('\n')
    const moved = moves.get(index) ?? null
    if (section.kind === 'Add' || section.kind === 'Delete') {
      const sign = section.kind === 'Add' ? '+' : '-'
      // Add/Delete bodies carry a sign per line but no hunk header.
      const stripped = section.body
        .map((line) => (line.startsWith(sign) ? line.slice(1) : line))
        .join('\n')
      const whole = editLinesFromWholeFile(stripped, section.kind === 'Add' ? 'add' : 'del')
      return [
        finalizeEditFile({
          path: section.path,
          oldPath: null,
          changeKind: section.kind === 'Add' ? 'added' : 'deleted',
          lines: whole.lines,
          lineNumbersKnown: true,
          truncated: whole.truncated
        })
      ]
    }
    // The first chunk of an update may carry no hunk header at all, and a file
    // whose body cannot be read as a hunk would otherwise vanish from a
    // multi-file envelope with nothing to say it was dropped.
    const parsed = editLinesFromUnifiedPatch(body, { implicitFirstHunk: true })
    if (!parsed) {
      return []
    }
    return [
      finalizeEditFile({
        path: moved ?? section.path,
        oldPath: moved ? section.path : null,
        changeKind: moved ? 'renamed' : 'edited',
        lines: parsed.lines,
        lineNumbersKnown: parsed.lineNumbersKnown,
        truncated: parsed.truncated
      })
    ]
  })
}
