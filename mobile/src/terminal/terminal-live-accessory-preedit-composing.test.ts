import { describe, expect, it } from 'vitest'
import { computeTerminalLiveMirrorStep } from './terminal-live-preedit-mirror'
import { getTerminalLiveAccessoryLocalEditText } from './terminal-live-text-commit'

/**
 * Accessory Backspace edits the field itself, so it must report whether a preedit
 * is still open. Omitting that report falls back to an Android-only code-point
 * heuristic that reads a pinyin preedit — plain ASCII — as committed text.
 */
describe('accessory backspace while composing', () => {
  const held = 'ni hao'

  it('holds an ASCII preedit when composing is reported', () => {
    const edited = getTerminalLiveAccessoryLocalEditText({
      localEdit: 'backspace',
      fieldText: held
    })
    const step = computeTerminalLiveMirrorStep('', edited, {
      commitHeld: false,
      composing: true
    })
    expect(step.appendText).toBe('')
    expect(step.nextSentText).toBe('')
    expect(step.heldText).toBe('ni ha')
  })

  it('leaks the same preedit to the PTY when the report is dropped', () => {
    const step = computeTerminalLiveMirrorStep('', 'ni ha', {
      commitHeld: false,
      composing: undefined
    })
    // Pins the failure the call site must avoid: this is what omitting the
    // third argument produced, and the candidate commit would append after it.
    expect(step.appendText).toBe('ni ha')
  })
})
