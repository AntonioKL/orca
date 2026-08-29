import { describe, expect, it } from 'vitest'
import { restoreRejectedBufferedTerminalDraft } from './buffered-terminal-draft-restoration'

describe('buffered terminal draft restoration', () => {
  it('restores the exact rejected draft when the composer is still empty', () => {
    expect(restoreRejectedBufferedTerminalDraft('', '  echo a–b  ', true)).toBe('  echo a–b  ')
  })

  it('preserves newer text composed while the rejected send was in flight', () => {
    expect(restoreRejectedBufferedTerminalDraft('next command', 'rejected command', true)).toBe(
      'next command'
    )
  })

  it('does not restore a rejected draft into a different focused surface', () => {
    expect(restoreRejectedBufferedTerminalDraft('', 'old tab command', false)).toBe('')
  })
})
