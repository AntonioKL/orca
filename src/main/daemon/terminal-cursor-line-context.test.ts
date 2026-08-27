import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'
import { HeadlessEmulator } from './headless-emulator'
import { readTerminalCursorLineContext } from './terminal-cursor-line-context'

function writeSync(terminal: Terminal, data: string): void {
  const core = (terminal as unknown as { _core: { writeSync(data: string): void } })._core
  core.writeSync(data)
}

describe('readTerminalCursorLineContext', () => {
  it.each([
    { cols: 19, cursorRowTail: 'proceed with the ', continuation: 'release' },
    { cols: 18, cursorRowTail: 'proceed with the', continuation: ' release' }
  ])(
    'preserves a space at a dimmed soft-wrap boundary with $cols columns',
    ({ cols, cursorRowTail, continuation }) => {
      const terminal = new Terminal({ cols, rows: 6, allowProposedApi: true })
      writeSync(
        terminal,
        `${'─'.repeat(cols)}\r\n❯ \x1b7\x1b[2mproceed with the release\x1b[22m\x1b8`
      )

      const context = readTerminalCursorLineContext(terminal, 16)

      expect(context?.rawAfterCursor).toBe(cursorRowTail)
      expect(context?.rowsBelow).toEqual([continuation, '', '', ''])
      expect(context?.rowsBelowWrapped).toEqual([true, false, false, false])
      expect(detectTerminalComposerDraft(context)?.text).toBe('proceed with the release')
      terminal.dispose()
    }
  )

  it('preserves a typed space before the cursor moves onto a wrapped row', () => {
    const terminal = new Terminal({ cols: 19, rows: 6, allowProposedApi: true })
    writeSync(terminal, '───────────────────\r\n❯ proceed with the release')

    const context = readTerminalCursorLineContext(terminal, 16)

    expect(context?.typedRows).toEqual(['───────────────────', '❯ proceed with the ', 'release'])
    expect(context?.rowsWrapped).toEqual([false, false, true])
    expect(detectTerminalComposerDraft(context)?.text).toBe('proceed with the release')
    terminal.dispose()
  })

  it('finds a composer prompt more than 16 wrapped rows above the cursor', async () => {
    const draft = `proceed ${'with '.repeat(65)}release`
    const emulator = new HeadlessEmulator({ cols: 19, rows: 30 })
    await emulator.write(`${'─'.repeat(19)}\r\n❯ ${draft}`)

    const context = emulator.getCursorLineContext()

    expect(context?.rows.length).toBeGreaterThan(17)
    expect(detectTerminalComposerDraft(context)?.text).toBe(draft)
    emulator.dispose()
  })
})
