import { describe, expect, it } from 'vitest'
import { shouldDismissKeyboardAfterTerminalSend } from './agent-send-keyboard-dismissal'

describe('shouldDismissKeyboardAfterTerminalSend', () => {
  it('dismisses for a live agent session', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend({
        type: 'terminal',
        agentStatus: { agentType: 'claude' }
      })
    ).toBe(true)
  })

  it('dismisses off launchAgent before the first agent-status update lands', () => {
    expect(shouldDismissKeyboardAfterTerminalSend({ type: 'terminal', launchAgent: 'codex' })).toBe(
      true
    )
  })

  it('keeps the keyboard for a plain shell so back-to-back commands stay typeable', () => {
    expect(shouldDismissKeyboardAfterTerminalSend({ type: 'terminal' })).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend({ type: 'terminal', agentStatus: null })).toBe(
      false
    )
  })

  it('treats a blank agent label as no agent', () => {
    // A truthy-empty agentType would otherwise dismiss on every shell Enter.
    expect(
      shouldDismissKeyboardAfterTerminalSend({ type: 'terminal', agentStatus: { agentType: '' } })
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend({ type: 'terminal', agentStatus: { agentType: '  ' } })
    ).toBe(false)
    expect(
      shouldDismissKeyboardAfterTerminalSend({
        type: 'terminal',
        agentStatus: { agentType: null },
        launchAgent: null
      })
    ).toBe(false)
  })

  it('falls through to launchAgent only when live status carries no agent', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend({
        type: 'terminal',
        agentStatus: { agentType: null },
        launchAgent: 'claude'
      })
    ).toBe(true)
  })

  it('never dismisses for non-terminal tabs or a missing tab', () => {
    expect(
      shouldDismissKeyboardAfterTerminalSend({
        type: 'markdown',
        agentStatus: { agentType: 'claude' }
      })
    ).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(null)).toBe(false)
    expect(shouldDismissKeyboardAfterTerminalSend(undefined)).toBe(false)
  })
})
