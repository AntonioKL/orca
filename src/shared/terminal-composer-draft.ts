export type TerminalCursorContext = {
  rows: string[]
  typedRows: string[]
  promptGlyphBoldRows: boolean[]
  rowsWrapped?: boolean[]
  rowsBelow: string[]
  typedRowsBelow: string[]
  rowsBelowWrapped?: boolean[]
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
  endRow: number
  promptGlyph: '❯' | '›' | '»'
}

export const TERMINAL_COMPOSER_CONTEXT_ROWS = 16

function dimmedContinuationRows(
  context: TerminalCursorContext,
  afterCursor: string
): { text: string; wrapped: boolean }[] {
  if (!afterCursor.trim() || context.afterCursor.trim()) {
    return []
  }
  const continuation: { text: string; wrapped: boolean }[] = []
  for (let index = 0; index < context.rowsBelow.length; index += 1) {
    const raw = context.rowsBelow[index] ?? ''
    if (!raw.trim() || (context.typedRowsBelow[index] ?? '').trim()) {
      break
    }
    continuation.push({
      text: raw.trim(),
      wrapped: context.rowsBelowWrapped?.[index] ?? false
    })
  }
  return continuation
}

function isStockPlaceholder(
  afterCursor: string,
  continuationRows: { text: string; wrapped: boolean }[]
): boolean {
  const text = [afterCursor, ...continuationRows.map((row) => row.text)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    /^Try\s+["“]/.test(text) ||
    text === 'Ask Codex to do anything' ||
    text === 'Ask a follow-up question'
  )
}

export function detectTerminalComposerDraft(
  context: TerminalCursorContext | null | undefined
): TerminalComposerDraft | null {
  if (!context || context.cursorHidden || context.rows.length === 0) {
    return null
  }
  const cursorIndex = context.rows.length - 1
  let afterCursor = context.afterCursor || context.rawAfterCursor
  let continuationRows = dimmedContinuationRows(context, afterCursor)
  if (isStockPlaceholder(afterCursor, continuationRows)) {
    afterCursor = ''
    continuationRows = []
  }
  const cursorText = `${context.beforeCursor}${afterCursor}`
  for (let index = cursorIndex; index >= 0; index -= 1) {
    const row = context.rows[index] ?? ''
    const glyph = row.match(/^\s*([❯›»])/)?.[1] as '❯' | '›' | '»' | undefined
    if (glyph) {
      if (glyph === '❯' && !/^[─━-]{8,}\s*$/.test(context.rows[index - 1] ?? '')) {
        return null
      }
      if ((glyph === '›' || glyph === '»') && context.promptGlyphBoldRows[index] !== true) {
        return null
      }
      const lines: { text: string; wrapped: boolean }[] =
        index === cursorIndex
          ? [{ text: cursorText.replace(/^\s*[❯›»]\s?/, ''), wrapped: false }, ...continuationRows]
          : [
              {
                text: (context.typedRows[index] ?? row).replace(/^\s*[❯›»]\s?/, ''),
                wrapped: false
              },
              ...context.typedRows.slice(index + 1, cursorIndex).map((text, offset) => ({
                text,
                wrapped: context.rowsWrapped?.[index + 1 + offset] ?? false
              })),
              {
                text: cursorText,
                wrapped: context.rowsWrapped?.[cursorIndex] ?? false
              },
              ...continuationRows
            ]
      const text = lines
        .map(
          (line, lineIndex) => `${lineIndex > 0 && !line.wrapped ? '\n' : ''}${line.text.trim()}`
        )
        .join('')
        .trim()
      if (!text) {
        return null
      }
      return {
        text,
        promptRow: context.cursorViewportRow - (cursorIndex - index),
        cursorRow: context.cursorViewportRow,
        endRow: context.cursorViewportRow + continuationRows.length,
        promptGlyph: glyph
      }
    }
    if (row.length > 0 && !/^\s/.test(row)) {
      return null
    }
  }
  return null
}
