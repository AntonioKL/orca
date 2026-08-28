import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './use-tab-agent'

describe('command identity tab-agent precedence', () => {
  it('ranks trusted command identity below process and above the existing lower rungs', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: true,
        launchAgent: 'claude'
      })
    ).toBe('codex')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        processAgent: 'pi',
        commandAgent: 'codex',
        commandTrusted: true,
        launchAgent: 'claude'
      })
    ).toBe('pi')
  })

  it('uses untrusted command identity only when title supplies none', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Gemini CLI',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: false
      })
    ).toBe('gemini')
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: false,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        commandAgent: 'codex',
        commandTrusted: false
      })
    ).toBe('codex')
  })
})
