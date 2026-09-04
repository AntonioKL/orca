// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isMacPlatform } from './native-chat-shortcut'
import { useNativeChatFontScale } from './use-native-chat-font-scale'

afterEach(cleanup)

function increaseFontScale(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: '=',
      ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true })
    })
  )
}

describe('useNativeChatFontScale', () => {
  it('ignores zoom shortcuts while a conversation is parked', () => {
    const view = renderHook(
      ({ isVisible }) => useNativeChatFontScale({ enabled: true, isVisible }),
      { initialProps: { isVisible: false } }
    )

    act(increaseFontScale)
    expect(view.result.current.scale).toBe(1)

    view.rerender({ isVisible: true })
    act(increaseFontScale)
    expect(view.result.current.scale).toBe(1.1)

    view.rerender({ isVisible: false })
    act(increaseFontScale)
    expect(view.result.current.scale).toBe(1.1)
  })
})
