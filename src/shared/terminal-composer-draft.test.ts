import { describe, expect, it } from 'vitest'
import { detectTerminalComposerDraft } from './terminal-composer-draft'

describe('detectTerminalComposerDraft', () => {
  it('separates a cursor-right suggestion from the composer line', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ proceed with the release'],
        typedRows: ['────────', '❯'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '❯ ',
        afterCursor: '',
        rawAfterCursor: 'proceed with the release',
        cursorHidden: false,
        cursorViewportRow: 8
      })
    ).toEqual({
      text: 'proceed with the release',
      promptRow: 8,
      cursorRow: 8,
      endRow: 8,
      promptGlyph: '❯'
    })
  })

  it('keeps stock dim placeholders out of draft metadata', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› Ask Codex to do anything'],
        typedRows: ['›'],
        promptGlyphBoldRows: [true],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '› ',
        afterCursor: '',
        rawAfterCursor: 'Ask Codex to do anything',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toBeNull()
  })

  it('does not duplicate real typed text left of the cursor', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ review the change'],
        typedRows: ['────────', '❯ review the change'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '❯ review the change',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 2
      })?.text
    ).toBe('review the change')
  })

  it('preserves a shell prompt that happens to use the Claude glyph', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['last command output', '❯ git status'],
        typedRows: ['last command output', '❯ git status'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '❯ git status',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 7
      })
    ).toBeNull()
  })

  it('rejects a hidden-cursor dialog even when its selected row uses a composer glyph', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› 1. Yes, continue', '  Press enter to continue'],
        typedRows: ['› 1. Yes, continue', '  Press enter to continue'],
        promptGlyphBoldRows: [true, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '  Press enter to continue',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: true,
        cursorViewportRow: 5
      })
    ).toBeNull()
  })

  it('separates dimmed suggestion rows below the restored cursor', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['────────', '❯ proceed with the release'],
        typedRows: ['────────', '❯'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: ['  and close the pull request', '────────'],
        typedRowsBelow: ['', '────────'],
        beforeCursor: '❯ ',
        afterCursor: '',
        rawAfterCursor: 'proceed with the release',
        cursorHidden: false,
        cursorViewportRow: 8
      })
    ).toEqual({
      text: 'proceed with the release\nand close the pull request',
      promptRow: 8,
      cursorRow: 8,
      endRow: 9,
      promptGlyph: '❯'
    })
  })

  it('recognizes the bold Codex ultra composer glyph', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['» review the change'],
        typedRows: ['» review the change'],
        promptGlyphBoldRows: [true],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '» review the change',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toMatchObject({ text: 'review the change', promptGlyph: '»' })
  })

  it('preserves an ordinary shell prompt that uses the Codex glyph', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['last command output', '› git status'],
        typedRows: ['last command output', '› git status'],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '› git status',
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: false,
        cursorViewportRow: 7
      })
    ).toBeNull()
  })

  it('keeps the side-thread placeholder out of draft metadata', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› Ask a follow-up question'],
        typedRows: ['›'],
        promptGlyphBoldRows: [true],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: '› ',
        afterCursor: '',
        rawAfterCursor: 'Ask a follow-up question',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toBeNull()
  })

  it('keeps a wrapped stock placeholder out of draft metadata', () => {
    expect(
      detectTerminalComposerDraft({
        rows: ['› Ask Codex to do'],
        typedRows: ['›'],
        promptGlyphBoldRows: [true],
        rowsBelow: ['  anything'],
        typedRowsBelow: [''],
        beforeCursor: '› ',
        afterCursor: '',
        rawAfterCursor: 'Ask Codex to do',
        cursorHidden: false,
        cursorViewportRow: 4
      })
    ).toBeNull()
  })
})
