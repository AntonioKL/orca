import { describe, expect, it } from 'vitest'
import {
  pruneBufferedTerminalDrafts,
  restoreRejectedBufferedTerminalDraft,
  updateBufferedTerminalDraft
} from './buffered-terminal-draft-restoration'

describe('buffered terminal draft restoration', () => {
  it('restores the exact rejected draft when the composer is still empty', () => {
    expect(
      restoreRejectedBufferedTerminalDraft({ terminal: '' }, 'terminal', '  echo a–b  ')
    ).toEqual({ terminal: '  echo a–b  ' })
  })

  it('preserves newer text composed while the rejected send was in flight', () => {
    const drafts = { terminal: 'next command' }
    expect(restoreRejectedBufferedTerminalDraft(drafts, 'terminal', 'rejected command')).toBe(
      drafts
    )
  })

  it('restores a rejection to terminal A after switching to terminal B', () => {
    const terminalA = 'terminal-a'
    const terminalB = 'terminal-b'
    const rejectedDraft = '  echo exact–text  '
    let activeHandle = terminalA
    const sendOrigin = activeHandle
    let drafts = { [terminalA]: rejectedDraft, [terminalB]: 'new command for B' }
    drafts = updateBufferedTerminalDraft(drafts, sendOrigin, '')
    activeHandle = terminalB

    drafts = restoreRejectedBufferedTerminalDraft(drafts, sendOrigin, rejectedDraft)

    expect(activeHandle).toBe(terminalB)
    expect(drafts).toEqual({
      [terminalA]: rejectedDraft,
      [terminalB]: 'new command for B'
    })
  })

  it('prunes drafts when their terminal lifetime ends', () => {
    const liveDrafts = { live: 'keep' }
    expect(pruneBufferedTerminalDrafts(liveDrafts, new Set(['live']))).toBe(liveDrafts)
    expect(
      pruneBufferedTerminalDrafts({ live: 'keep', closed: 'drop' }, new Set(['live']))
    ).toEqual({ live: 'keep' })
  })
})
