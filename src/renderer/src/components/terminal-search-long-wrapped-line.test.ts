// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX } from '../../../shared/terminal-scrollback-policy'
import { safeFind } from './terminal-search-safe-find'

/**
 * Regression for crash report 012eb5be (Orca 1.4.194, win32): searching a pane
 * that held one un-newlined line — base64, a minified bundle, a single huge log
 * record — threw `RangeError: Maximum call stack size exceeded` out of
 * TerminalSearch's effect and tripped the `terminal.workbench` error boundary.
 *
 * Mechanism, in @xterm/addon-search's SearchEngine (patched in
 * config/patches/@xterm__addon-search@*.patch, generated from the source patch
 * under config/patches/xterm-src/): `_findInLine` rewound to the first row of a
 * wrapped line by calling itself once per wrapped row, so recursion depth equals
 * the number of screen rows the logical line occupies. Scrollback reaches
 * DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX rows, which is far past V8's stack.
 *
 * The rewind is reached on every re-entry into the middle of a wrapped line —
 * `_highlightAllMatches` restarting at the row after a match, and `findNext`
 * resuming from the current selection — so this drives the real Terminal +
 * SearchAddon through Orca's own `safeFind`, which deliberately rethrows
 * anything that is not the decoration error.
 */

const COLS = 80
const ROWS = 24
/** Long enough that the wrap chain outruns V8's stack on any host. */
const WRAPPED_ROWS = 12_000
const NEEDLE = 'needle'

// Matches the decoration options TerminalSearch passes, so the highlight-all
// pass (the crash's entry point) actually runs.
const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
} as const

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function openTerminalWithSearch(): { terminal: Terminal; search: SearchAddon } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
  })
  terminal.open(container)
  const search = new SearchAddon()
  terminal.loadAddon(search)
  return { terminal, search }
}

describe('terminal search inside one very long wrapped line', () => {
  beforeEach(() => {
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('rewinds to the start of the line without overflowing the stack', async () => {
    const { terminal, search } = openTerminalWithSearch()
    // One line of WRAPPED_ROWS screen rows whose only match ends on the
    // second-to-last row, so the highlight pass resumes one row further on and
    // has to rewind the whole chain to reach the line start.
    await write(
      terminal,
      'x'.repeat(COLS * (WRAPPED_ROWS - 1) - NEEDLE.length) + NEEDLE + 'x'.repeat(COLS)
    )

    const find = (): boolean =>
      safeFind((term, options) => search.findNext(term, options), NEEDLE, {
        decorations: SEARCH_DECORATIONS
      })

    let found: boolean | undefined
    expect(() => {
      found = find()
    }).not.toThrow()
    expect(found).toBe(true)

    // Second find resumes from the selection, deep inside the wrapped line.
    expect(() => {
      found = find()
    }).not.toThrow()
    expect(found).toBe(true)
  })
})
