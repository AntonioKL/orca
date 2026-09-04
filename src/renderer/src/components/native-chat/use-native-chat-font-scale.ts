import { useCallback, useEffect, useState, type RefObject } from 'react'
import {
  chatFontScaleActionForEvent,
  decreaseChatFontScale,
  DEFAULT_CHAT_FONT_SCALE,
  increaseChatFontScale
} from './native-chat-font-scale'
import { isMacPlatform } from './native-chat-shortcut'
import { registerNativeChatZoomOwner } from './native-chat-zoom-owner'
import type { UIZoomDirection } from '../../../../shared/ui-zoom-level'

export type ChatFontScaleControls = {
  /** Current chat text scale (1 = default). Apply as a font-size multiplier. */
  scale: number
  increase: () => void
  decrease: () => void
  reset: () => void
}

/**
 * In-session chat font scale plus desktop routed zoom and web Cmd/Ctrl +/-/0
 * bindings. The scale lives in component state (in-session is fine per the plan).
 */
export function useNativeChatFontScale({
  enabled,
  isVisible,
  rootRef
}: {
  enabled: boolean
  isVisible: boolean
  rootRef: RefObject<HTMLDivElement | null>
}): ChatFontScaleControls {
  const [scale, setScale] = useState(DEFAULT_CHAT_FONT_SCALE)

  const increase = useCallback(() => setScale((s) => increaseChatFontScale(s)), [])
  const decrease = useCallback(() => setScale((s) => decreaseChatFontScale(s)), [])
  const reset = useCallback(() => setScale(DEFAULT_CHAT_FONT_SCALE), [])

  const applyZoom = useCallback(
    (direction: UIZoomDirection) => {
      if (direction === 'in') {
        increase()
      } else if (direction === 'out') {
        decrease()
      } else {
        reset()
      }
    },
    [decrease, increase, reset]
  )

  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !isVisible || !root) {
      return
    }
    return registerNativeChatZoomOwner(root, applyZoom)
  }, [applyZoom, enabled, isVisible, rootRef])

  useEffect(() => {
    const root = rootRef.current
    const isWebClient =
      (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
    if (!enabled || !isVisible || !isWebClient || !root) {
      return
    }
    const isMac = isMacPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = chatFontScaleActionForEvent(e, isMac)
      if (!action) {
        return
      }
      if (!root.contains(document.activeElement)) {
        return
      }
      // Why: capture-phase + preventDefault so the chord drives chat zoom instead
      // of the host (Electron) page zoom, and only while chat is active.
      e.preventDefault()
      e.stopPropagation()
      applyZoom(action === 'increase' ? 'in' : action === 'decrease' ? 'out' : 'reset')
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [applyZoom, enabled, isVisible, rootRef])

  return { scale, increase, decrease, reset }
}
