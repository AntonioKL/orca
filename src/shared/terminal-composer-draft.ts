export type TerminalCursorContext = {
  rows: string[]
  typedRows: string[]
  beforeCursor: string
  afterCursor: string
  rawAfterCursor: string
  cursorHidden: boolean
  cursorViewportRow: number
}

export type TerminalComposerDraft = {
  text: string
  promptRow: number
  cursorRow: number
  promptGlyph: '❯' | '›'
}

export const TERMINAL_COMPOSER_CONTEXT_ROWS = 16

function visibleAfterCursor(context: TerminalCursorContext): string {
  const raw = (context.afterCursor || context.rawAfterCursor).trim()
  if (/^Try\s+["“]/.test(raw) || raw === 'Ask Codex to do anything') {
    return ''
  }
  return context.afterCursor || context.rawAfterCursor
}

export function detectTerminalComposerDraft(
  context: TerminalCursorContext | null | undefined
): TerminalComposerDraft | null {
  if (!context || context.cursorHidden || context.rows.length === 0) {
    return null
  }
  const cursorIndex = context.rows.length - 1
  const cursorText = `${context.beforeCursor}${visibleAfterCursor(context)}`
  for (let index = cursorIndex; index >= 0; index -= 1) {
    const row = context.rows[index] ?? ''
    const glyph = row.match(/^\s*([❯›])/)?.[1] as '❯' | '›' | undefined
    if (glyph) {
      if (glyph === '❯' && !/^[─━-]{8,}\s*$/.test(context.rows[index - 1] ?? '')) {
        return null
      }
      const lines =
        index === cursorIndex
          ? [cursorText.replace(/^\s*[❯›]\s?/, '')]
          : [
              (context.typedRows[index] ?? row).replace(/^\s*[❯›]\s?/, ''),
              ...context.typedRows.slice(index + 1, cursorIndex),
              cursorText
            ]
      const text = lines
        .map((line) => line.trim())
        .join('\n')
        .trim()
      if (!text) {
        return null
      }
      return {
        text,
        promptRow: context.cursorViewportRow - (cursorIndex - index),
        cursorRow: context.cursorViewportRow,
        promptGlyph: glyph
      }
    }
    if (row.length > 0 && !/^\s/.test(row)) {
      return null
    }
  }
  return null
}
