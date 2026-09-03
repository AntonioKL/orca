// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Uri } from 'monaco-editor'

const editorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown>) => {
    // Why: @monaco-editor/react resolves `path` with this exact call before creating the model.
    Uri.parse(String(props.path))
    editorProps.current = props
    return null
  },
  loader: { config: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', terminalFontSize: 13 },
      editorFontZoomLevel: 0,
      setPendingEditorReveal: vi.fn(),
      setEditorCursorLine: vi.fn(),
      addDiffComment: vi.fn(),
      deleteDiffComment: vi.fn(),
      updateDiffComment: vi.fn(),
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: vi.fn(),
      worktreeDiffComments: {}
    })
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({
  useDiffCommentDecorator: vi.fn()
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: vi.fn(), toastNode: null })
}))

import MonacoEditor from './MonacoEditor'

const WSL_COLON_PATH =
  '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\notes:2026.md'

function renderEditor(filePath: string): void {
  render(
    <MonacoEditor
      fileId="file"
      filePath={filePath}
      viewStateKey="pane:file"
      relativePath="notes:2026.md"
      content="# notes"
      language="markdown"
      onContentChange={vi.fn()}
      onSave={vi.fn()}
      readOnly
    />
  )
}

afterEach(() => {
  cleanup()
  editorProps.current = null
})

describe('MonacoEditor model path', () => {
  it('passes ordinary paths through unchanged', () => {
    renderEditor('/repo/file.py')
    expect(editorProps.current?.path).toBe('/repo/file.py')
  })

  it('hands Monaco a parseable path for a WSL/UNC file name carrying a colon', () => {
    expect(() => renderEditor(WSL_COLON_PATH)).not.toThrow()
    expect(() => Uri.parse(String(editorProps.current?.path))).not.toThrow()
  })
})
