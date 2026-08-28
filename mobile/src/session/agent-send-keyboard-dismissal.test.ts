import { describe, expect, it } from 'vitest'
import { shouldDismissKeyboardAfterTerminalSend } from './agent-send-keyboard-dismissal'

describe('shouldDismissKeyboardAfterTerminalSend', () => {
  it('dismisses for a live agent session', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        {
          type: 'terminal',
          agentStatus: { agentType: 'claude' }
        },
        true
      )
    ).toBe(true)
  })

  it('dismisses off launchAgent before the first agent-status update lands', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend({ type: 'terminal', launchAgent: 'codex' }, true)
    ).toBe(true)
  })

  it('keeps the keyboard when an agent send is rejected', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        { type: 'terminal', agentStatus: { agentType: 'claude' } },
        false
      )
    ).toBe(false)
  })

  it('keeps the keyboard for a plain shell so back-to-back commands stay typeable', () => {
    expect(shouldDismissKeyboardAfterTerminalSend({ type: 'terminal' }, true)).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend({ type: 'terminal', agentStatus: null }, true)
    ).toBe(false)
  })

  it('treats a blank agent label as no agent', () => {
    // A truthy-empty agentType would otherwise dismiss on every shell Enter.
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        { type: 'terminal', agentStatus: { agentType: '' } },
        true
      )
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        { type: 'terminal', agentStatus: { agentType: '  ' } },
        true
      )
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        {
          type: 'terminal',
          agentStatus: { agentType: null },
          launchAgent: null
        },
        true
      )
    ).toBe(false)
  })

  it('falls through to launchAgent only when live status carries no agent', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        {
          type: 'terminal',
          agentStatus: { agentType: null },
          launchAgent: 'claude'
        },
        true
      )
    ).toBe(true)
  })

  it('never dismisses for non-terminal tabs or a missing tab', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend(
        {
          type: 'markdown',
          agentStatus: { agentType: 'claude' }
        },
        true
      )
    ).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(null, true)).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(undefined, true)).toBe(false)
  })
})
