import { editFilesFromBeginPatch, unwrapBeginPatch } from './native-chat-begin-patch'
import { editLinesFromContents } from './native-chat-edit-lcs'
import {
  finalizeEditFile,
  type NativeChatEditFile,
  type NativeChatEditLine
} from './native-chat-edit-model'
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from './native-chat-unified-patch'
import type { NativeChatEditPatch } from './native-chat-types'

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'str_replace'])
const PATCH_TOOLS = new Set(['apply_patch', 'exec', 'shell', 'Diff', 'local_shell'])

export function isEditToolName(name: string): boolean {
  return CLAUDE_EDIT_TOOLS.has(name) || PATCH_TOOLS.has(name)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Rows straight from resolved hunks, which is the only path with true numbers
 *  for a provider that reports its edits as a snippet pair. */
function linesFromEditPatch(patch: NativeChatEditPatch): NativeChatEditLine[] {
  const lines: NativeChatEditLine[] = []
  for (const hunk of patch.hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const raw of hunk.lines) {
      if (raw.startsWith('+')) {
        lines.push({ kind: 'add', text: raw.slice(1), oldLineNumber: null, newLineNumber: newNo })
        newNo += 1
      } else if (raw.startsWith('-')) {
        lines.push({ kind: 'del', text: raw.slice(1), oldLineNumber: oldNo, newLineNumber: null })
        oldNo += 1
      } else {
        lines.push({
          kind: 'context',
          text: raw.startsWith(' ') ? raw.slice(1) : raw,
          oldLineNumber: oldNo,
          newLineNumber: newNo
        })
        oldNo += 1
        newNo += 1
      }
    }
  }
  return lines
}

function claudeEditFiles(input: Record<string, unknown>): NativeChatEditFile[] | null {
  const path = text(input.file_path) ?? text(input.path) ?? text(input.notebook_path)
  const oldString = text(input.old_string) ?? text(input.oldString)
  const newString = text(input.new_string) ?? text(input.newString)
  const content = text(input.content) ?? text(input.file_text)
  if (oldString === null && content !== null) {
    return [
      finalizeEditFile({
        path: path ?? 'file',
        oldPath: null,
        changeKind: 'added',
        lines: editLinesFromWholeFile(content, 'add'),
        lineNumbersKnown: true
      })
    ]
  }
  if (oldString === null && newString === null) {
    return null
  }
  return [
    finalizeEditFile({
      path: path ?? 'file',
      oldPath: null,
      changeKind: 'edited',
      lines: editLinesFromContents(oldString ?? '', newString ?? content ?? ''),
      // A snippet pair cannot say where in the file it sits.
      lineNumbersKnown: false
    })
  ]
}

function codexChangeFiles(changes: unknown[]): NativeChatEditFile[] {
  return changes.flatMap((entry) => {
    const change = record(entry)
    const path = text(change?.path)
    const diff = text(change?.diff)
    if (!change || !path || !diff) {
      return []
    }
    const kind = record(change.kind)
    const kindType = text(kind?.type) ?? text(change.kind) ?? 'update'
    const movePath = text(kind?.move_path) ?? text(change.movePath)
    if (kindType === 'add' || kindType === 'delete') {
      // Add and delete arrive as raw file content, with no hunk header or signs.
      return [
        finalizeEditFile({
          path,
          oldPath: null,
          changeKind: kindType === 'add' ? 'added' : 'deleted',
          lines: editLinesFromWholeFile(diff, kindType === 'add' ? 'add' : 'del'),
          lineNumbersKnown: true
        })
      ]
    }
    // A move is appended to the diff body as prose rather than a header field.
    const body = diff.replace(/\n*Moved to: .*$/, '')
    const parsed = editLinesFromUnifiedPatch(body)
    if (!parsed) {
      return []
    }
    return [
      finalizeEditFile({
        path: movePath ?? path,
        oldPath: movePath ? path : null,
        changeKind: movePath ? 'renamed' : 'edited',
        lines: parsed.lines,
        lineNumbersKnown: parsed.lineNumbersKnown
      })
    ]
  })
}

/** One diff model for a tool call and its result, across every shape the
 *  supported agents use to report a file edit. */
export function editFilesFromToolPair(pair: {
  name: string
  input: unknown
  result?: { output?: string; editPatch?: NativeChatEditPatch }
}): NativeChatEditFile[] | null {
  const input = record(pair.input)
  const patch = pair.result?.editPatch
  if (patch && patch.hunks.length > 0) {
    return [
      finalizeEditFile({
        path: patch.filePath ?? text(input?.file_path) ?? 'file',
        oldPath: null,
        changeKind: 'edited',
        lines: linesFromEditPatch(patch),
        lineNumbersKnown: true
      })
    ]
  }

  const envelope = unwrapBeginPatch(pair.input)
  if (envelope) {
    const files = editFilesFromBeginPatch(envelope)
    if (files.length > 0) {
      return files
    }
  }

  if (input && Array.isArray(input.changes)) {
    const files = codexChangeFiles(input.changes)
    if (files.length > 0) {
      return files
    }
  }

  if (input && CLAUDE_EDIT_TOOLS.has(pair.name)) {
    return claudeEditFiles(input)
  }

  const patchText = text(input?.patch) ?? text(input?.diff) ?? pair.result?.output ?? null
  if (patchText && PATCH_TOOLS.has(pair.name)) {
    const parsed = editLinesFromUnifiedPatch(patchText)
    if (parsed) {
      return [
        finalizeEditFile({
          path: text(input?.path) ?? text(input?.file_path) ?? 'file',
          oldPath: null,
          changeKind: 'edited',
          lines: parsed.lines,
          lineNumbersKnown: parsed.lineNumbersKnown
        })
      ]
    }
  }
  return null
}
