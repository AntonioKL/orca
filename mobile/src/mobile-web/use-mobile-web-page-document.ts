import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { MobileWebHealthDeadline } from './mobile-web-health-deadline'
import type { MobileWebNativeRouteHandoff } from './mobile-web-native-route-handoff'

/**
 * The shell owns the document lifecycle, so it also owns the page-scoped state that dies with a
 * document: what was initialized, what reported ready, and the health deadline armed for it.
 *
 * A document is replaced without the shell session, its build or the view epoch moving at all — a
 * native-route excursion deactivates the view to about:blank and reloads on return, the route error
 * boundary reloads in place, and a re-attached view reloads its URL. Each of those mints a new page
 * with new subscription ids while the previous page's broker survives, and its records keep holding
 * every per-operation grant (one for workspace, account and source control), so the new document's
 * subscribes are refused with `rate_limited` for the life of the shell session. The document epoch
 * is that boundary: it retires the outgoing page's broker before the incoming one initializes.
 */
export function useMobileWebPageDocument({
  sessionId,
  viewEpoch,
  healthDeadlineRef,
  routeHandoffRef
}: {
  sessionId: string | undefined
  viewEpoch: number
  healthDeadlineRef: MutableRefObject<MobileWebHealthDeadline>
  routeHandoffRef: MutableRefObject<MobileWebNativeRouteHandoff>
}): {
  epoch: number
  initializedSessionRef: MutableRefObject<string | undefined>
  readySessionId: string | undefined
  setReadySessionId: (sessionId: string | undefined) => void
  onLoadStart: () => void
  onLoaded: () => void
} {
  const initializedSessionRef = useRef<string | undefined>(undefined)
  const loadedRef = useRef(false)
  const [epoch, setEpoch] = useState(0)
  const [readySessionId, setReadySessionId] = useState<string>()

  useEffect(() => {
    initializedSessionRef.current = undefined
    loadedRef.current = false
    routeHandoffRef.current.clear()
    setReadySessionId(undefined)
    healthDeadlineRef.current.clear()
    return () => healthDeadlineRef.current.clear()
  }, [epoch, healthDeadlineRef, routeHandoffRef, sessionId, viewEpoch])

  const onLoadStart = useCallback(() => {
    // Only a load that displaces a document that finished loading is a replacement. The shell posts
    // `loading` for the first load too, and more than once per load, and neither is a new page.
    if (!loadedRef.current) {
      return
    }
    loadedRef.current = false
    setEpoch((current) => current + 1)
  }, [])

  const onLoaded = useCallback(() => {
    loadedRef.current = true
  }, [])

  return {
    epoch,
    initializedSessionRef,
    readySessionId,
    setReadySessionId,
    onLoadStart,
    onLoaded
  }
}
