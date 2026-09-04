import { useMemo } from 'react'
import { usePathname, useRouter } from 'expo-router'
import { leaveHostRoute } from '../host-route-exit'
import { useForceReconnect, useForgetHostClient } from '../transport/client-context'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY } from '../mobile-web/mobile-web-native-capability-authority'
import { navigateFromHostScreenList } from './host-screen-route-navigation'
import type { HostScreenShellOperations } from './host-screen-shell-operations'

export function useDefaultHostScreenShellOperations(args: {
  hostId: string | undefined
  embedded: boolean
}): HostScreenShellOperations {
  const router = useRouter()
  const pathname = usePathname()
  const closeHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()

  return useMemo(
    () => ({
      leaveHost() {
        leaveHostRoute(router)
      },
      navigateFromHostList(target: string) {
        navigateFromHostScreenList({
          router,
          pathname,
          target,
          embedded: args.embedded,
          hostId: args.hostId
        })
      },
      openConnectionDiagnostics() {
        router.push({ pathname: '/connection-log', params: { hostId: args.hostId ?? '' } })
      },
      openExternalUrl(url: string) {
        return MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY.openExternal(url)
      },
      reconnect() {
        return args.hostId ? forceReconnectHost(args.hostId) : Promise.resolve()
      },
      repairPairing() {
        router.push('/pair-scan')
      },
      removeHost(hostPublicKey: string) {
        if (!args.hostId || !hostPublicKey) {
          return Promise.reject(new Error('Host identity unavailable'))
        }
        return removeHostAndCloseClient(args.hostId, hostPublicKey, closeHostClient)
      }
    }),
    [args.embedded, args.hostId, closeHostClient, forceReconnectHost, pathname, router]
  )
}
