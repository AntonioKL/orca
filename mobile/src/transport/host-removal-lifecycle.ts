import {
  clearWatermark,
  forgetHostNotificationSession
} from '../notifications/notification-reconnect-catchup'
import { removeHost } from './host-store'
import { connectionLogStore } from './persisted-connection-log-store'
import { removeMobileWebHostCache } from '../mobile-web/mobile-web-native-stager'
import { clearMobileWebColdResumeRouteForHost } from '../mobile-web/mobile-web-cold-resume-route'

export async function removeHostAndCloseClient(
  hostId: string,
  hostPublicKey: string,
  forgetHostClient: (hostId: string) => void
): Promise<void> {
  // Why: cache deletion is recoverable by redownload, while a completed unpair must not leave host code behind.
  await removeMobileWebHostCache(hostPublicKey)
  await clearMobileWebColdResumeRouteForHost(hostId)
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  await removeHost(hostId)
  try {
    forgetHostClient(hostId)
  } finally {
    // Why: host-scoped process state must not survive a completed unpair.
    forgetHostNotificationSession(hostId)
    void clearWatermark(hostId)
    connectionLogStore.delete(hostId)
  }
}
