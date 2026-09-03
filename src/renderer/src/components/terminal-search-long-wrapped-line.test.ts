// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
} from '../../../shared/terminal-scrollback-policy'
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
/** A line longer than this scrollback loses its first rows: the bug is eviction, not size. */
const TRIMMED_HEAD_SCROLLBACK = 100
const TRIMMED_HEAD_LINE_ROWS = 200
const NEEDLE = 'needle'
/**
 * A full-buffer scan runs on the renderer's main thread on every keystroke in
 * the find bar, so anything near this is a visible freeze rather than a slow
 * search. Unfixed it is ~18s for a default-scrollback buffer; fixed, ~6ms.
 */
const FULL_SCAN_BUDGET_MS = 5_000

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

function openTerminalWithSearch(scrollback: number = DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX): {
  terminal: Terminal
  search: SearchAddon
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback })
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

  it('scans a long wrapped line once, not once per wrapped row', async () => {
    const { terminal, search } = openTerminalWithSearch()
    await write(terminal, 'x'.repeat(COLS * DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

    // No match, so the scan visits every row: the shape that froze the pane.
    const startedAt = performance.now()
    safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      decorations: SEARCH_DECORATIONS
    })

    expect(performance.now() - startedAt).toBeLessThan(FULL_SCAN_BUDGET_MS)
  })

  it('reports every match inside a wrapped line', async () => {
    const { terminal, search } = openTerminalWithSearch()
    let resultCount = -1
    search.onDidChangeResults((event) => {
      resultCount = event.resultCount
    })
    // One logical line wrapping over three rows with a match in each, then a
    // separate unwrapped line.
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    await write(terminal, `${paddedNeedle.repeat(3)}\r\nplain ${NEEDLE}\r\n`)

    safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      decorations: SEARCH_DECORATIONS
    })

    expect(resultCount).toBe(4)
  })

  it('keeps reaching matches in a wrapped line whose first row was trimmed away', async () => {
    const { terminal, search } = openTerminalWithSearch(TRIMMED_HEAD_SCROLLBACK)
    // One long line whose head is evicted, so the surviving chain begins on a
    // row marked isWrapped and no line start is left in the buffer to cover it.
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    const lead = 'x'.repeat(COLS * (TRIMMED_HEAD_LINE_ROWS - 3))
    await write(terminal, `${lead}${paddedNeedle.repeat(2)}${'x'.repeat(COLS)}\r\n`)
    for (let i = 0; i < 60; i++) {
      await write(terminal, `line ${i}\r\n`)
    }
    const buffer = terminal.buffer.active
    expect(buffer.getLine(0)?.isWrapped).toBe(true)

    const matchRows: number[] = []
    for (let y = 0; y < buffer.length; y++) {
      if (buffer.getLine(y)?.translateToString().includes(NEEDLE)) {
        matchRows.push(y)
      }
    }
    expect(matchRows.length).toBe(2)

    // Cycle far enough to come back round: the surviving rows must stay
    // reachable, not be visited once and then stranded.
    const visits = new Map<number, number>()
    for (let i = 0; i < 12; i++) {
      safeFind((term, options) => search.findNext(term, options), NEEDLE, {
        decorations: SEARCH_DECORATIONS
      })
      const row = terminal.getSelectionPosition()?.start.y
      if (row !== undefined) {
        visits.set(row, (visits.get(row) ?? 0) + 1)
      }
    }

    for (const row of matchRows) {
      expect(visits.get(row) ?? 0).toBeGreaterThan(1)
    }
  })

  it('still finds a whole-word match that only matches from a later wrapped row', async () => {
    const { terminal, search } = openTerminalWithSearch()
    // From the line start the first hit is `aneedlea`, which wholeWord rejects
    // without looking further, so the match on the second row is only reachable
    // by searching that row — it must not be skipped as already covered.
    const filler = 'x'.repeat(COLS - NEEDLE.length - 2)
    await write(terminal, `a${NEEDLE}a${filler} ${NEEDLE} ${filler}`)

    const found = safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      wholeWord: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
  })
})
