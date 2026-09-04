// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMacPlatform } from './native-chat-shortcut'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { dispatchNativeChatZoom } from './native-chat-zoom-owner'

beforeEach(() => {
  ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
})

afterEach(() => {
  cleanup()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
})

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
    const root = document.createElement('div')
    root.dataset.nativeChatRoot = 'true'
    root.tabIndex = -1
    document.body.append(root)
    root.focus()
    const view = renderHook(
      ({ isVisible }) =>
        useNativeChatFontScale({ enabled: true, isVisible, rootRef: { current: root } }),
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
    root.remove()
  })

  it('does not capture web zoom outside the focused chat', () => {
    const root = document.createElement('div')
    root.dataset.nativeChatRoot = 'true'
    document.body.append(root)
    const view = renderHook(() =>
      useNativeChatFontScale({ enabled: true, isVisible: true, rootRef: { current: root } })
    )

    document.body.focus()
    act(increaseFontScale)
    expect(view.result.current.scale).toBe(1)
    root.remove()
  })

  it('applies routed desktop zoom only to the focused chat owner', () => {
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    const root = document.createElement('div')
    root.dataset.nativeChatRoot = 'true'
    const composer = document.createElement('textarea')
    root.append(composer)
    const view = renderHook(
      ({ isVisible }) =>
        useNativeChatFontScale({ enabled: true, isVisible, rootRef: { current: root } }),
      { initialProps: { isVisible: true } }
    )

    act(() => {
      expect(dispatchNativeChatZoom(composer, 'in')).toBe(true)
    })
    expect(view.result.current.scale).toBe(1.1)
    expect(dispatchNativeChatZoom(document.body, 'in')).toBe(false)

    view.rerender({ isVisible: false })
    expect(dispatchNativeChatZoom(composer, 'in')).toBe(false)
  })
})
