import type { IBufferLine, Terminal } from '@xterm/headless'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'

function undimmedText(line: IBufferLine, fromX = 0): string {
  let text = ''
  for (let x = fromX; x < line.length; x += 1) {
    const cell = line.getCell(x)
    if (!cell || cell.isDim() || cell.getWidth() === 0) {
      continue
    }
    text += cell.getChars() || ' '
  }
  return text.trimEnd()
}

export function readTerminalCursorLineContext(
  terminal: Terminal,
  rowsAbove: number
): TerminalCursorContext | null {
  const buffer = terminal.buffer.active
  const cursorRow = buffer.baseY + buffer.cursorY
  const cursorLine = buffer.getLine(cursorRow)
  if (!cursorLine) {
    return null
  }
  const rows: string[] = []
  const typedRows: string[] = []
  const start = Math.max(buffer.viewportY, cursorRow - Math.max(0, Math.floor(rowsAbove)))
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row)
    rows.push(line?.translateToString(true) ?? '')
    typedRows.push(line ? undimmedText(line) : '')
  }
  return {
    rows,
    typedRows,
    beforeCursor: cursorLine.translateToString(true, 0, buffer.cursorX),
    afterCursor: undimmedText(cursorLine, buffer.cursorX),
    rawAfterCursor: cursorLine.translateToString(true, buffer.cursorX),
    cursorHidden: !terminal.modes.showCursor,
    cursorViewportRow: cursorRow - buffer.viewportY
  }
}
