import { describe, expect, it } from 'vitest'

import {
  formatDeferredTerminalPasteDroppedError,
  formatTerminalPasteExecutionError,
  TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE
} from './terminal-paste-errors'

describe('terminal paste error copy', () => {
  it('tells the user how to recover a deferred paste that timed out, per platform', () => {
    // The payload is already gone, so the copy has to be actionable, and the chord
    // label has to match the platform the user is actually on (reported on Win 11).
    expect(formatDeferredTerminalPasteDroppedError('darwin')).toBe(
      'Paste cancelled: terminal focus did not return in time. Click the terminal and press ⌘V to paste again.'
    )
    expect(formatDeferredTerminalPasteDroppedError('win32')).toBe(
      'Paste cancelled: terminal focus did not return in time. Click the terminal and press Ctrl+V to paste again.'
    )
    expect(formatDeferredTerminalPasteDroppedError('linux')).toBe(
      'Paste cancelled: terminal focus did not return in time. Click the terminal and press Ctrl+V to paste again.'
    )
  })

  it('names a failed clipboard read as a failure, never as an empty clipboard', () => {
    expect(TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE).toBe(
      'Paste failed: could not read the clipboard. Copy again, then retry.'
    )
    // Distinct from every execution-stage message, so the toast cannot be mistaken
    // for a focus or transport problem.
    const executionMessages = (
      [
        'payload-too-large',
        'stale-target',
        'target-disconnected',
        'pty-writer-unavailable',
        'operation-timeout',
        undefined
      ] as const
    ).map((reason) => formatTerminalPasteExecutionError(reason))
    expect(executionMessages).not.toContain(TERMINAL_CLIPBOARD_READ_UNAVAILABLE_MESSAGE)
  })
})
