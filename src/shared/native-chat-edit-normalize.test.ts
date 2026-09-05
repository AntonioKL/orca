import { describe, expect, it } from 'vitest'
import { editFilesFromToolPair, isEditToolName } from './native-chat-edit-normalize'
import { unifiedLineNumber } from './native-chat-edit-model'
import { editLinesFromUnifiedPatch } from './native-chat-unified-patch'
import { unwrapBeginPatch } from './native-chat-begin-patch'

const gutter = (files: ReturnType<typeof editFilesFromToolPair>): (number | null)[] =>
  (files ?? []).flatMap((file) => file.lines.map((line) => unifiedLineNumber(line)))

describe('editLinesFromUnifiedPatch', () => {
  it('numbers deletes from the old side and adds from the new side', () => {
    const parsed = editLinesFromUnifiedPatch('@@ -12,3 +12,3 @@\n ctx\n-was\n+now\n tail')
    expect(parsed?.lineNumbersKnown).toBe(true)
    expect(parsed?.lines.map((line) => [line.kind, unifiedLineNumber(line)])).toEqual([
      ['context', 12],
      ['del', 13],
      ['add', 13],
      ['context', 14]
    ])
  })

  it('leaves rows unnumbered when the hunk header carries no ranges', () => {
    const parsed = editLinesFromUnifiedPatch('@@\n ctx\n-was\n+now')
    expect(parsed?.lineNumbersKnown).toBe(false)
    expect(parsed?.lines.every((line) => unifiedLineNumber(line) === null)).toBe(true)
  })

  it('returns null for text with no hunk header', () => {
    expect(editLinesFromUnifiedPatch('just prose\n- a bullet')).toBeNull()
  })
})

describe('unwrapBeginPatch', () => {
  it('recovers an envelope escaped inside a JavaScript string literal', () => {
    const source =
      'const patch = "*** Begin Patch\\n*** Update File: a.ts\\n@@\\n-x\\n+y\\n*** End Patch"'
    expect(unwrapBeginPatch(source)).toBe(
      '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch'
    )
  })

  it('leaves an already-decoded envelope alone', () => {
    const plain = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch'
    expect(unwrapBeginPatch(plain)).toBe(plain)
  })

  it('ignores input with no envelope', () => {
    expect(unwrapBeginPatch('ls -la')).toBeNull()
  })
})

describe('editFilesFromToolPair', () => {
  it('renders a Codex exec apply_patch, which previously produced no diff', () => {
    const files = editFilesFromToolPair({
      name: 'exec',
      input:
        'const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n ctx\\n-was\\n+now\\n*** End Patch"'
    })
    expect(files).toHaveLength(1)
    expect(files?.[0]?.path).toBe('src/a.ts')
    expect(files?.[0]?.changeKind).toBe('edited')
    expect(files?.[0]?.added).toBe(1)
    expect(files?.[0]?.removed).toBe(1)
    // Codex hunk headers are context anchors, so no row may claim a file position.
    expect(files?.[0]?.lineNumbersKnown).toBe(false)
  })

  it('numbers an added file from 1', () => {
    const files = editFilesFromToolPair({
      name: 'exec',
      input: '*** Begin Patch\n*** Add File: new.ts\n+one\n+two\n*** End Patch'
    })
    expect(files?.[0]?.changeKind).toBe('added')
    expect(files?.[0]?.lineNumbersKnown).toBe(true)
    expect(gutter(files)).toEqual([1, 2])
  })

  it('reads a move header as a rename', () => {
    const files = editFilesFromToolPair({
      name: 'exec',
      input:
        '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch'
    })
    expect(files?.[0]?.changeKind).toBe('renamed')
    expect(files?.[0]?.oldPath).toBe('old.ts')
    expect(files?.[0]?.path).toBe('new.ts')
  })

  it('interleaves a Claude snippet pair without claiming line positions', () => {
    const files = editFilesFromToolPair({
      name: 'Edit',
      input: {
        file_path: '/repo/a.ts',
        old_string: 'keep\nwas\ntail',
        new_string: 'keep\nnow\ntail'
      }
    })
    expect(files?.[0]?.lines.map((line) => line.kind)).toEqual(['context', 'del', 'add', 'context'])
    expect(files?.[0]?.lineNumbersKnown).toBe(false)
  })

  it('prefers the resolved hunks on the result over the snippet pair', () => {
    const files = editFilesFromToolPair({
      name: 'Edit',
      input: { file_path: '/repo/a.ts', old_string: 'was', new_string: 'now' },
      result: {
        editPatch: {
          filePath: '/repo/a.ts',
          hunks: [
            {
              oldStart: 12,
              oldLines: 3,
              newStart: 12,
              newLines: 3,
              lines: [' ctx', '-was', '+now', ' tail']
            }
          ]
        }
      }
    })
    expect(files?.[0]?.lineNumbersKnown).toBe(true)
    expect(gutter(files)).toEqual([12, 13, 13, 14])
  })

  it('treats a Write as an added file', () => {
    const files = editFilesFromToolPair({
      name: 'Write',
      input: { file_path: '/repo/new.ts', content: 'one\ntwo\n' }
    })
    expect(files?.[0]?.changeKind).toBe('added')
    expect(gutter(files)).toEqual([1, 2])
  })

  it('reads Codex structured changes, stripping the move marker from the body', () => {
    const files = editFilesFromToolPair({
      name: 'apply_patch',
      input: {
        changes: [
          {
            path: 'old.ts',
            kind: { type: 'update', move_path: 'new.ts' },
            diff: '@@ -1,2 +1,2 @@\n-a\n+b\n\nMoved to: new.ts'
          }
        ]
      }
    })
    expect(files?.[0]?.changeKind).toBe('renamed')
    expect(files?.[0]?.lines.some((line) => line.text.includes('Moved to'))).toBe(false)
    expect(gutter(files)).toEqual([1, 1])
  })

  it('reads a Codex add change, which arrives as raw content with no hunk header', () => {
    const files = editFilesFromToolPair({
      name: 'apply_patch',
      input: { changes: [{ path: 'new.ts', kind: { type: 'add' }, diff: 'one\ntwo' }] }
    })
    expect(files?.[0]?.changeKind).toBe('added')
    expect(files?.[0]?.added).toBe(2)
  })

  it('returns null for a tool that did not edit a file', () => {
    expect(editFilesFromToolPair({ name: 'Bash', input: { command: 'ls' } })).toBeNull()
    expect(isEditToolName('Bash')).toBe(false)
    expect(isEditToolName('Edit')).toBe(true)
  })
})
