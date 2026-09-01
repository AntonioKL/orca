import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react'
import { AppState } from 'react-native'
import { consumeRecentMobileWebUserGesture } from './mobile-web-user-gesture'

export type MobileWebUserGestureAuthority = {
  consumeRecentUserGesture: () => boolean
  // Witnesses the gesture without spending it: presenting an OS dialog must not disarm the gated
  // action the dialog is confirming.
  hasRecentUserGesture: () => boolean
}

type MobileWebAppForegroundAuthority = {
  updateAppForegroundState(foreground: boolean): void
}

export function useMobileWebUserGestureAuthority(
  occurredAtRef: MutableRefObject<number | null>,
  foregroundAuthorityRef: RefObject<MobileWebAppForegroundAuthority | null>
): MobileWebUserGestureAuthority {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      foregroundAuthorityRef.current?.updateAppForegroundState(nextState === 'active')
      if (nextState !== 'active') {
        occurredAtRef.current = null
      }
    })
    return () => subscription.remove()
  }, [foregroundAuthorityRef, occurredAtRef])

  const hasRecentUserGesture = useCallback(
    () =>
      consumeRecentMobileWebUserGesture({
        appState: AppState.currentState,
        occurredAt: occurredAtRef.current,
        now: Date.now()
      }),
    [occurredAtRef]
  )
  const consumeRecentUserGesture = useCallback(() => {
    const recent = hasRecentUserGesture()
    occurredAtRef.current = null
    return recent
  }, [hasRecentUserGesture, occurredAtRef])

  return { consumeRecentUserGesture, hasRecentUserGesture }
}
