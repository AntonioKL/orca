import { useEffect } from 'react'
import { useAppStore } from '../store'
import { isWebClientLocation } from '../lib/web-client-location'
import { clearLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-apply'
import { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

export { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
export {
  refreshLocalStructuredSessionTabs,
  restoreLocalStructuredSessionTabsOnce
} from './local-structured-session-tabs-sync/inventory-refresh'
export {
  applyLocalStructuredSessionTabSnapshots,
  applyStructuredSessionTabSnapshots,
  clearLocalStructuredSessionTabs,
  LOCAL_STRUCTURED_SESSION_OWNER,
  removeLocalStructuredSessionTabs
} from './local-structured-session-tabs-sync/snapshot-apply'
export { projectLocalStructuredSessionTabs } from './local-structured-session-tabs-sync/snapshot-projection'
export { startLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync/subscription'

export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  const enabled = useAppStore((state) => state.settings?.experimentalStructuredNativeChat === true)
  // The web preload swaps its sole active runtime environment in place when a new host is paired.
  // Restart the host-owned mirror so status/capability reads cannot bleed across that boundary.
  const webEnvironmentId = useAppStore((state) =>
    isWebClientLocation() ? (state.runtimeEnvironments[0]?.id ?? null) : null
  )
  useEffect(() => {
    if (!ready) {
      return
    }
    if (!enabled) {
      clearLocalStructuredSessionTabs()
      return
    }
    let disposed = false
    let unsubscribe = (): void => {}
    void startLocalStructuredSessionTabsSync({
      isDisposed: () => disposed,
      setUnsubscribe: (next) => {
        unsubscribe = next
      }
    }).catch((error) => console.warn('[structured-session-tabs] sync failed', error))
    return () => {
      disposed = true
      unsubscribe()
      clearLocalStructuredSessionTabs()
    }
  }, [enabled, ready, webEnvironmentId])
}
