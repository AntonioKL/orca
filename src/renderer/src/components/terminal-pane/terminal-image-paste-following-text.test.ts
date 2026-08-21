import { describe, expect, it, vi } from 'vitest'

import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPaste,
  type TerminalPasteTarget
} from './terminal-paste-coordinator'

function terminalTarget(): TerminalPasteTarget {
  return {
    kind: 'terminal',
    paneId: 1,
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    runtime: {
      platform: 'darwin',
      runtimeKey: 'local:darwin',
      kind: 'local'
    }
  }
}

function createTerminal() {
  return {
    modes: { bracketedPasteMode: true },
    options: { ignoreBracketedPasteMode: false },
    input: vi.fn(),
    paste: vi.fn()
  }
}

describe('clipboard image paste through plan → execute → pasteTerminalText', () => {
  it('writes a trailing space after the bracketed image path so later typing cannot glue', async () => {
    const terminal = createTerminal()
    const plan = planTerminalPaste({
      text: '/tmp/orca-paste-1760000000000-id.png',
      source: 'keyboard',
      target: terminalTarget(),
      forceBracketedPaste: true,
      followedByNonImageInput: true
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: (text, options) => pasteTerminalText(terminal, text, options),
      isTargetCurrent: () => true
    })

    expect(result.status).toBe('pasted')
    const imageBytes = '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~ '
    expect(terminal.input).toHaveBeenCalledWith(imageBytes)
    expect(`${imageBytes}describe this`).toBe(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~ describe this'
    )
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('does not append a trailing space to forced-bracketed multiline text paste', async () => {
    const terminal = createTerminal()
    const plan = planTerminalPaste({
      text: 'one\r\ntwo',
      source: 'keyboard',
      target: terminalTarget(),
      forceBracketedPasteForMultiline: true
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: (text, options) => pasteTerminalText(terminal, text, options),
      isTargetCurrent: () => true
    })

    expect(result.status).toBe('pasted')
    expect(plan.mode).toBe('bracketed-terminal')
    expect(terminal.input).toHaveBeenCalledWith('\x1b[200~one\rtwo\x1b[201~')
    expect(terminal.paste).not.toHaveBeenCalled()
  })
})
