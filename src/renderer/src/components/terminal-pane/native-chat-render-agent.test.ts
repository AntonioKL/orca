import { describe, expect, it } from 'vitest'
import { resolveNativeChatRenderAgent } from './native-chat-render-agent'

describe('native chat render agent', () => {
  it('passes Claude through to a structured native chat surface', () => {
    expect(
      resolveNativeChatRenderAgent({
        structuredSessionId: 'claude-session-1',
        structuredSessionAgent: 'claude',
        terminalAgent: 'codex'
      })
    ).toBe('claude')
  })

  it.each([undefined, 'gemini'])('rejects structured provider metadata %s', (provider) => {
    expect(
      resolveNativeChatRenderAgent({
        structuredSessionId: 'structured-session-1',
        structuredSessionAgent: provider,
        terminalAgent: 'codex'
      })
    ).toBeNull()
  })

  it('keeps terminal-native-chat agent resolution when no structured session exists', () => {
    expect(
      resolveNativeChatRenderAgent({
        structuredSessionId: null,
        structuredSessionAgent: undefined,
        terminalAgent: 'codex'
      })
    ).toBe('codex')
  })
})
