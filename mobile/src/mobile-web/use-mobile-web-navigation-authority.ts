import { useMemo, type RefObject } from 'react'
import { leaveHostRoute } from '../host-route-exit'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import type { MobileWebNativeRouteHandoff } from './mobile-web-native-route-handoff'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

type MobileWebShellRouter = {
  dismissTo: (href: '/') => void
  push: (href: '/pair-scan') => void
}

export function useMobileWebNavigationAuthority({
  hostId,
  hostPublicKeyB64,
  routeHandoffRef,
  router,
  clearColdResumeRoute,
  closeHostClient,
  forceReconnectHost,
  consumeRecentUserGesture
}: {
  hostId: string | undefined
  hostPublicKeyB64: string | undefined
  routeHandoffRef: RefObject<MobileWebNativeRouteHandoff>
  router: MobileWebShellRouter
  clearColdResumeRoute: () => void
  closeHostClient: (hostId: string) => void
  forceReconnectHost: (hostId: string) => void | Promise<void>
  consumeRecentUserGesture: () => boolean
}): MobileWebNavigationAuthority | undefined {
  return useMemo(() => {
    if (!hostId || !hostPublicKeyB64) {
      return undefined
    }
    return {
      route(destination, requestId) {
        if (destination === 'terminalSettings') {
          routeHandoffRef.current.record(requestId, destination)
          return
        }
        clearColdResumeRoute()
        if (destination === 'hostPicker') {
          leaveHostRoute(router)
        } else {
          router.push('/pair-scan')
        }
      },
      reconnect() {
        return forceReconnectHost(hostId)
      },
      removeHost() {
        return removeHostAndCloseClient(hostId, hostPublicKeyB64, closeHostClient)
      },
      consumeRecentUserGesture
    }
  }, [
    clearColdResumeRoute,
    closeHostClient,
    consumeRecentUserGesture,
    forceReconnectHost,
    hostId,
    hostPublicKeyB64,
    routeHandoffRef,
    router
  ])
}
