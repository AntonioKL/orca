import { finalizeEditFile, type NativeChatEditFile } from './native-chat-edit-model'
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from './native-chat-unified-patch'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/

/** Codex sends `apply_patch` as source for its `exec` tool, so the envelope
 *  arrives inside a JavaScript string literal. Recover the envelope text. */
export function unwrapBeginPatch(input: unknown): string | null {
  const source =
    typeof input === 'string'
      ? input
      : typeof input === 'object' && input !== null
        ? firstStringField(input as Record<string, unknown>)
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
  const region = source.slice(start, end + END.length)
  // A region with no real newlines is still a single-line string literal.
  return region.includes('\n') ? region : decodeStringLiteral(region)
}

function firstStringField(record: Record<string, unknown>): string | null {
  for (const key of ['input', 'command', 'patch', 'arguments', 'script']) {
    const value = record[key]
    if (typeof value === 'string' && value.includes(BEGIN)) {
      return value
    }
  }
  return null
}

function decodeStringLiteral(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.startsWith('u')) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    }
    const known: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' }
    return known[escape] ?? escape
  })
}

/** Splits a `*** Begin Patch` envelope into one entry per file it touches. */
export function editFilesFromBeginPatch(envelope: string): NativeChatEditFile[] {
  const sections: { kind: 'Add' | 'Update' | 'Delete'; path: string; body: string[] }[] = []
  let movePath: string | null = null
  const moves = new Map<number, string>()

  for (const raw of envelope.split('\n')) {
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
    if (raw === BEGIN || raw === END || sections.length === 0) {
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
    const parsed = editLinesFromUnifiedPatch(body)
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
