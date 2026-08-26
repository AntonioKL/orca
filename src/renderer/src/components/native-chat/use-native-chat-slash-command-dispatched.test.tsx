// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCommandMarkerCacheForTests } from './native-chat-command-marker'
import { useNativeChatSlashCommandDispatched } from './use-native-chat-slash-command-dispatched'

const SCOPE = { paneKey: 'tab-1:leaf-1', agent: 'claude', sessionId: 'session-1' } as const

describe('useNativeChatSlashCommandDispatched', () => {
  const onSwitchToTerminal = vi.fn()
  const setCommandMarkers = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    clearCommandMarkerCacheForTests()
  })

  const render = (agent: 'claude' | 'openclaude' | 'codex') =>
    renderHook(() =>
      useNativeChatSlashCommandDispatched({
        agent,
        commandMarkerScope: { ...SCOPE, agent },
        setCommandMarkers,
        onSwitchToTerminal
      })
    )

  it.each(['claude', 'openclaude', 'codex'] as const)(
    'reveals the terminal when %s dispatches /resume',
    (agent) => {
      // STA-4617: the agent answers it with its own picker, drawn in the TUI the
      // chat view is covering — staying put makes the command look inert.
      const hook = render(agent)
      act(() => hook.result.current('/resume'))

      expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
    }
  )

  it('leaves the chat view in place for commands the agent answers inline', () => {
    const hook = render('claude')
    act(() => {
      hook.result.current('/clear')
      hook.result.current('/compact')
      hook.result.current('resume the refactor')
    })

    expect(onSwitchToTerminal).not.toHaveBeenCalled()
  })

  it('still records the local marker for a revealing command', () => {
    // The reveal is additive: `/resume` is a control action with no transcript
    // turn, so it needs its `Ran /resume` line exactly like `/clear` does.
    const hook = render('claude')
    act(() => hook.result.current('/resume'))

    expect(setCommandMarkers).toHaveBeenCalledTimes(1)
    expect(setCommandMarkers.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ command: '/resume' })
    ])
  })
})
